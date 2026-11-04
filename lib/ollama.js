// Vékony Ollama kliens: modellek listázása és streamelt chat.

export const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

let modelCache = { at: 0, models: [] };

export async function listModels(force = false) {
  if (!force && Date.now() - modelCache.at < 15000) return modelCache.models;
  const res = await fetch(`${HOST}/api/tags`);
  if (!res.ok) throw new Error(`Ollama nem érhető el (${res.status})`);
  const data = await res.json();
  const models = (data.models || []).map(m => ({
    name: m.name,
    size: m.size,
    params: m.details?.parameter_size || '',
    family: m.details?.family || '',
    contextLength: m.details?.context_length || null,
    capabilities: m.capabilities || null,
    remote: Boolean(m.remote_host),
  }));
  modelCache = { at: Date.now(), models };
  return models;
}

async function supportsThinking(model) {
  try {
    const m = (await listModels()).find(x => x.name === model);
    return Boolean(m?.capabilities?.includes('thinking'));
  } catch {
    return false;
  }
}

/** Modell kivétele a memóriából (keep_alive: 0). */
export async function unload(model) {
  await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
}

/** A modell rétegeinek száma (a GPU-ra tehető rétegek: blokkok + kimeneti réteg). */
export async function layerCount(model) {
  try {
    const res = await fetch(`${HOST}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const info = (await res.json()).model_info || {};
    const n = info[`${info['general.architecture']}.block_count`];
    if (Number.isInteger(n)) return n + 1;
  } catch {
    /* alapérték */
  }
  return 32;
}

async function loadedModels() {
  try {
    const res = await fetch(`${HOST}/api/ps`);
    return ((await res.json()).models || []).map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Kis memóriájú gépen (pl. 24 GB) az író és a lektor nem fér el egyszerre: a másikat kivesszük,
 * különben az Ollama csonkán tölti be a nagy modellt, és GPU-memóriahiánnyal elszáll.
 */
async function makeRoom(model, others) {
  const loaded = await loadedModels();
  for (const m of new Set(others)) {
    if (m && m !== model && loaded.includes(m)) await unload(m);
  }
}

/**
 * Streamelt chat hívás. A tokeneket az onToken / onThinking callbackeken adja tovább.
 * Visszatér: { content, thinking, stats }
 */
export async function chat({ model, messages, format, think, options, signal, onToken, onThinking, evict = [] }) {
  if (evict.length) await makeRoom(model, evict);
  const body = { model, messages, stream: true, options, keep_alive: '30m' };
  if (format) body.format = format;
  if (typeof think === 'boolean' && (await supportsThinking(model))) body.think = think;

  let res;
  try {
    res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Nem sikerült kapcsolódni az Ollamához (${HOST}): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Ollama hiba (${res.status}): ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let thinking = '';
  let stats = null;

  const handle = line => {
    const j = JSON.parse(line);
    if (j.error) throw new Error(`Ollama: ${j.error}`);
    const m = j.message || {};
    if (m.thinking) {
      thinking += m.thinking;
      onThinking?.(m.thinking);
    }
    if (m.content) {
      content += m.content;
      onToken?.(m.content);
    }
    if (j.done) stats = j;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  }
  if (buf.trim()) handle(buf.trim());

  if (!stats) {
    throw Object.assign(new Error(
      `Az Ollama válasza megszakadt (${model}). Ez legtöbbször memóriahiány: a modell nem fér el a GPU-memóriában. ` +
        'Kapcsold be a „modellek váltogatását”, csökkentsd a kontextusméretet, vagy nézd meg: ~/.ollama/logs/server.log',
    ), { oom: true });
  }
  if (!content.trim() && !format) {
    throw new Error(`A(z) ${model} üres választ adott (done_reason: ${stats.done_reason}).`);
  }

  if (stats?.done_reason === 'length') {
    content += '\n\n<!-- Figyelem: a modell elérte a kimeneti/kontextus korlátot, a szöveg csonka lehet. -->';
  }
  return { content, thinking, stats };
}
