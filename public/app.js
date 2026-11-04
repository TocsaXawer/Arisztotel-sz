import { renderMarkdown } from './md.js';

// ---------- segédek ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = p => p + Math.random().toString(36).slice(2, 10);
const words = t => (String(t || '').match(/[\p{L}\p{N}]+/gu) || []).length;
const fmt = n => n.toLocaleString('hu-HU');
const scoreClass = s => (s == null ? '' : s >= 8 ? 'good' : s >= 6 ? 'mid' : 'low');
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* nem baj */ } },
};

const STATUS = {
  empty: 'Még nincs megírva',
  writing: 'Írás folyamatban…',
  reviewing: 'Lektorálás folyamatban…',
  revising: 'Átdolgozás folyamatban…',
  done: 'Kész',
  review: 'Átnézendő – nem érte el a ponthatárt, vagy kötelező javítás maradt benne',
};

const S = {
  projects: [],
  p: null,
  models: [],
  ollama: { ok: null, host: '' },
  job: null,
  log: [],
  tab: 'brief',
  sel: null, // {ch, sec}
  editing: null, // {secId, text}
  tocInstruction: '',
  secInstruction: '',
  pending: new Set(),
  saveTimer: null,
  saveState: '',
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

const running = () => S.job?.state === 'running';
const busyHere = () => running() && S.job.projectId === S.p?.id;

function reqList() {
  return S.p.brief.requirements.filter(r => r.item.trim()).map((r, i) => ({ label: `K${i + 1}`, req: r }));
}

// ---------- mentés ----------
function markDirty(part) {
  S.pending.add(part);
  setSaveState('Mentés…');
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flush, 700);
}

async function flush() {
  clearTimeout(S.saveTimer);
  if (!S.p || !S.pending.size) return;
  const body = {};
  for (const part of S.pending) body[part] = S.p[part];
  S.pending.clear();
  try {
    const fresh = await api('PUT', `/api/projects/${S.p.id}`, body);
    S.p.updatedAt = fresh.updatedAt;
    setSaveState('Mentve');
    if (body.brief) updateProjectTitle();
  } catch (e) {
    setSaveState('Mentés sikertelen');
    toast(e.message, 'error');
  }
}

function setSaveState(t) {
  S.saveState = t;
  document.querySelectorAll('.save-state').forEach(el => (el.textContent = t));
}

function updateProjectTitle() {
  const item = S.projects.find(x => x.id === S.p.id);
  if (item) item.title = S.p.brief.title || S.p.brief.topic.slice(0, 60) || 'Névtelen könyv';
  renderProjectSelect();
}

// ---------- betöltés ----------
async function loadModels(refresh = false) {
  try {
    const r = await api('GET', `/api/models${refresh ? '?refresh' : ''}`);
    S.models = r.models;
    S.ollama = { ok: r.ok, host: r.host, error: r.error };
  } catch (e) {
    S.ollama = { ok: false, error: e.message };
  }
  renderOllama();
}

async function loadProjects() {
  S.projects = await api('GET', '/api/projects');
  renderProjectSelect();
}

async function openProject(id) {
  await flush();
  S.p = await api('GET', `/api/projects/${id}`);
  S.sel = null;
  S.editing = null;
  S.tab = S.p.phase === 'writing' ? 'write' : S.p.phase === 'toc' ? 'toc' : 'brief';
  store.set('ari.project', id);
  renderProjectSelect();
  render();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshProject, 250);
}

async function refreshProject() {
  if (!S.p) return;
  if (S.pending.size) return scheduleRefresh();
  const fresh = await api('GET', `/api/projects/${S.p.id}`).catch(() => null);
  if (!fresh || fresh.id !== S.p.id) return;
  if (S.tab === 'brief') {
    // az űrlapot nem rajzoljuk újra, hogy ne vesszen el a fókusz
    fresh.brief = S.p.brief;
    // a futás közben megtanult GPU-rétegszámot átvesszük, a többi beállítás a helyi marad
    for (const k of ['writerGpuLayers', 'criticGpuLayers']) {
      S.p.settings[k] = fresh.settings[k];
      const el = document.querySelector(`[data-bind="settings.${k}"]`);
      if (el && el !== document.activeElement) el.value = fresh.settings[k] ?? '';
    }
    fresh.settings = S.p.settings;
    S.p = fresh;
    return;
  }
  S.p = fresh;
  if (S.tab === 'write') {
    renderSide();
    if (!S.editing) renderSecPanel();
  } else renderMain();
}

// ---------- események (SSE) ----------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = e => handleEvent(JSON.parse(e.data));
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'snapshot':
      S.job = ev.job;
      S.log = ev.log || [];
      renderLog();
      renderJobHead();
      break;
    case 'job': {
      const wasRunning = running();
      const isNew = ev.job?.id !== S.job?.id;
      S.job = ev.job;
      if (isNew && ev.job?.state === 'running') {
        S.log = [];
        renderLog();
        openDrawer(true);
      }
      renderJobHead();
      if (wasRunning && ev.job.state !== 'running') {
        if (ev.job.state === 'done') toast(`Kész: ${ev.job.label}`, 'ok');
        else if (ev.job.state === 'error') toast(`Hiba: ${ev.job.error}`, 'error', 8000);
        else toast('A feladat leállítva.');
        loadProjects();
      }
      if (S.tab === 'brief') applyBusy();
      else scheduleRefresh();
      break;
    }
    case 'log':
      S.log.push(ev.entry);
      if (S.log.length > 80) S.log.shift();
      appendLogEntry(ev.entry);
      break;
    case 'token':
    case 'think': {
      const entry = [...S.log].reverse().find(x => x.kind === 'stream');
      if (!entry) break;
      if (ev.type === 'token') {
        entry.text += ev.text;
        entry._txt?.appendData(ev.text);
      } else {
        entry.thinking += ev.text;
        entry._think?.appendData(ev.text);
        if (entry._thinkWrap) entry._thinkWrap.hidden = false;
      }
      autoscroll();
      break;
    }
    case 'saved':
      if (ev.projectId === S.p?.id) scheduleRefresh();
      break;
  }
}

// ---------- napló ----------
let stick = true;
function autoscroll() {
  const log = $('#log');
  if (stick) log.scrollTop = log.scrollHeight;
}

function logEntryEl(entry) {
  const el = document.createElement('div');
  if (entry.kind === 'stream') {
    el.className = `stream ${entry.role}`;
    const head = document.createElement('div');
    head.className = 'sh';
    head.textContent = `${entry.role === 'writer' ? '✍ Író' : '🔍 Lektor'} · ${entry.model} · ${entry.title}`;
    const think = document.createElement('pre');
    think.className = 'think';
    entry._think = document.createTextNode(entry.thinking || '');
    think.append(entry._think);
    think.hidden = !entry.thinking;
    entry._thinkWrap = think;
    const txt = document.createElement('pre');
    entry._txt = document.createTextNode(entry.text || '');
    txt.append(entry._txt);
    el.append(head, think, txt);
  } else {
    el.className = entry.kind === 'error' ? 'error' : 'status';
    el.textContent = entry.kind === 'error' ? `Hiba: ${entry.text}` : entry.text;
  }
  return el;
}

function renderLog() {
  const log = $('#log');
  log.replaceChildren(...S.log.map(logEntryEl));
  autoscroll();
}

function appendLogEntry(entry) {
  const log = $('#log');
  log.append(logEntryEl(entry));
  while (log.children.length > 80) log.firstChild.remove();
  autoscroll();
}

function renderJobHead() {
  const j = S.job;
  const r = running();
  $('#job-spinner').hidden = !r;
  $('#stop-job').hidden = !r;
  const states = { done: '✓ Kész', error: '✕ Hiba', stopped: '■ Leállítva' };
  $('#job-label').textContent = j ? (r ? j.label : `${states[j.state] || ''}: ${j.label}`) : 'Nincs futó feladat';
}

function openDrawer(open) {
  $('#drawer').classList.toggle('collapsed', !open);
  $('#drawer-toggle').textContent = open ? '▾' : '▴';
}

// ---------- fejléc ----------
function renderOllama() {
  const o = S.ollama;
  const el = $('#ollama-status');
  if (o.ok === null) el.innerHTML = '<span class="dot"></span> Ollama…';
  else if (o.ok) el.innerHTML = `<span class="dot ok"></span> Ollama · ${S.models.length} modell`;
  else el.innerHTML = `<span class="dot bad"></span> Ollama nem érhető el`;
  el.title = o.ok ? o.host : o.error || '';
}

function renderProjectSelect() {
  const sel = $('#project-select');
  if (!S.projects.length) {
    sel.innerHTML = '<option value="">– nincs még könyv –</option>';
    return;
  }
  sel.innerHTML = S.projects
    .map(x => `<option value="${x.id}" ${x.id === S.p?.id ? 'selected' : ''}>${esc(x.title)}${x.sections ? ` (${x.written}/${x.sections})` : ''}</option>`)
    .join('');
}

function renderTabs() {
  document.querySelectorAll('#tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === S.tab);
    b.disabled = !S.p;
  });
}

// ---------- fő renderelés ----------
function render() {
  renderTabs();
  renderMain();
}

function renderMain() {
  const main = $('#main');
  if (!S.p) {
    main.innerHTML = `<div class="page"><div class="card empty-state">
      <h2>Üdv az Arisztotelészben!</h2>
      <p>Egy nagy modell írja a könyvet, egy kicsi lektorálja. Kezdd egy új könyvvel.</p>
      <button class="btn primary" data-action="new-project">+ Új könyv</button></div></div>`;
    return;
  }
  if (S.tab === 'brief') main.innerHTML = briefHtml();
  else if (S.tab === 'toc') main.innerHTML = tocHtml();
  else {
    main.innerHTML = writeShellHtml();
    renderSide();
    renderSecPanel();
  }
  applyBusy();
}

function applyBusy() {
  const b = busyHere() || running();
  document.querySelectorAll('[data-busy]').forEach(el => (el.disabled = b));
  setSaveState(S.saveState);
}

// ---------- 1. Adatok ----------
const LEVELS = ['kezdő', 'alapfokú', 'középhaladó', 'haladó', 'szakértői'];

function modelOptions(selected) {
  const usable = S.models.filter(m => !m.capabilities || m.capabilities.includes('completion'));
  const names = usable.map(m => m.name);
  const opts = usable.map(
    m => `<option value="${esc(m.name)}" ${m.name === selected ? 'selected' : ''}>${esc(m.name)}${m.params ? ` · ${esc(m.params)}` : ''}${m.remote ? ' · felhő' : ''}</option>`,
  );
  if (selected && !names.includes(selected)) opts.unshift(`<option value="${esc(selected)}" selected>${esc(selected)} (nincs telepítve!)</option>`);
  return opts.join('');
}

function briefHtml() {
  const b = S.p.brief;
  const s = S.p.settings;
  const reqs = b.requirements;
  let n = 0;
  const reqRows = reqs
    .map(r => {
      const label = r.item.trim() ? `K${++n}` : '·';
      return `<div class="req" data-req-id="${r.id}">
        <span class="lbl">${label}</span>
        <input type="text" data-req-field="item" value="${esc(r.item)}" placeholder="Mi legyen benne? pl. DHCP szerver">
        <textarea rows="2" data-req-field="how" placeholder="Hogyan? pl. elmélet: hogyan működik (DORA folyamat); beállítás Linuxon és Windows Serveren lépésről lépésre; gyakorló feladat megoldással">${esc(r.how)}</textarea>
        <button class="btn icon danger" data-action="del-req" title="Törlés">✕</button>
      </div>`;
    })
    .join('');
  const empty = !b.topic && !b.audience && !reqs.length;

  return `<div class="page">
  <div class="actions" style="margin-bottom:12px"><span class="grow"></span><span class="save-state"></span></div>
  ${empty ? `<div class="banner">Először jársz itt? <button class="btn small" data-action="fill-example">Példa betöltése (hálózati szolgáltatások)</button></div>` : ''}
  <section class="card">
    <h2>A könyv adatai</h2>
    <p class="hint">Minél pontosabban írod le, kinek és milyen szinten szól a könyv, annál jobb lesz a tartalomjegyzék.</p>
    <div class="grid2">
      <label class="field">Munkacím <input type="text" data-bind="brief.title" value="${esc(b.title)}" placeholder="pl. Hálózati szolgáltatások a gyakorlatban"></label>
      <label class="field">A könyv nyelve <input type="text" data-bind="brief.language" value="${esc(b.language)}"></label>
    </div>
    <label class="field">Téma, a könyv célja
      <textarea rows="3" data-bind="brief.topic" placeholder="pl. Linux és Windows szerveres hálózati alapszolgáltatások telepítése, beállítása és hibakeresése">${esc(b.topic)}</textarea></label>
    <div class="grid2">
      <label class="field">Kinek szól? (célközönség)
        <textarea rows="2" data-bind="brief.audience" placeholder="pl. technikumi 11–12. évfolyamos informatikus tanulók, alap hálózati ismeretekkel">${esc(b.audience)}</textarea></label>
      <label class="field">Milyen szinten?
        <select data-bind="brief.level">${LEVELS.map(l => `<option ${l === b.level ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="field">Stílus, hangnem <input type="text" data-bind="brief.style" value="${esc(b.style)}" placeholder="pl. közvetlen, tegező, sok valós példával és ábraleírással"></label>
    <div class="grid2">
      <label class="field">Fejezetek száma (kb.) <input type="number" min="1" max="60" data-bind="brief.chapterCount" value="${b.chapterCount}"></label>
      <label class="field">Szakaszonkénti terjedelem (szó, kb.) <input type="number" min="100" max="5000" step="50" data-bind="brief.wordsPerSection" value="${b.wordsPerSection}"></label>
    </div>
    <div class="field muted" style="font-size:13px;font-weight:500;margin-bottom:6px">Minden fejezet végén legyen:</div>
    <div class="checks">
      <label><input type="checkbox" data-bind="brief.extras.exercises" ${b.extras.exercises ? 'checked' : ''}> gyakorló feladatok</label>
      <label><input type="checkbox" data-bind="brief.extras.solutions" ${b.extras.solutions ? 'checked' : ''}> megoldásokkal</label>
      <label><input type="checkbox" data-bind="brief.extras.questions" ${b.extras.questions ? 'checked' : ''}> ellenőrző kérdések</label>
      <label><input type="checkbox" data-bind="brief.extras.summary" ${b.extras.summary ? 'checked' : ''}> összefoglaló</label>
    </div>
  </section>

  <section class="card">
    <h2>Kötelező tartalmi elemek</h2>
    <p class="hint">Mi az, aminek mindenképp szerepelnie kell, és hogyan. Az elemek K1, K2… azonosítót kapnak; a tartalomjegyzékben látod, melyik fejezet fedi le őket.</p>
    ${reqRows || '<p class="muted">Még nincs elem.</p>'}
    <div class="actions" style="margin-top:10px"><button class="btn" data-action="add-req">+ Elem hozzáadása</button></div>
  </section>

  <section class="card">
    <h2>Egyéb kérések</h2>
    <textarea rows="3" data-bind="brief.notes" placeholder="pl. A példákban Ubuntu Server 24.04 és Windows Server 2022 szerepeljen. Minden fejezet elején legyen tanulási cél.">${esc(b.notes)}</textarea>
  </section>

  <section class="card">
    <h2>Modellek</h2>
    <p class="hint">Az író modell írja a szöveget, a lektor modell véleményezi. Ha egy szakasz pontszáma a ponthatár alatt marad, az író átdolgozza (legfeljebb az átdolgozási körök számáig). Ha a két modell nem fér el egyszerre a memóriában, hagyd bekapcsolva a váltogatást.
      <button class="btn small" data-action="refresh-models">↻ Modellek frissítése</button></p>
    <div class="grid2">
      <label class="field">Író (nagy) modell <select data-bind="settings.writerModel">${modelOptions(s.writerModel)}</select></label>
      <label class="field">Lektor (kis) modell <select data-bind="settings.criticModel">${modelOptions(s.criticModel)}</select></label>
    </div>
    <div class="checks" style="margin-bottom:12px">
      <label><input type="checkbox" data-bind="settings.swapModels" ${s.swapModels ? 'checked' : ''}> Modellek váltogatása (a másikat kiveszi a memóriából – 32 GB alatt ajánlott)</label>
      <label><input type="checkbox" data-bind="settings.writerThink" ${s.writerThink ? 'checked' : ''}> Író gondolkodhat (thinking – lassabb, néha jobb)</label>
      <label><input type="checkbox" data-bind="settings.criticThink" ${s.criticThink ? 'checked' : ''}> Lektor gondolkodhat</label>
    </div>
    <div class="grid4">
      <label class="field">Ponthatár (1–10) <input type="number" min="1" max="10" data-bind="settings.passScore" value="${s.passScore}"></label>
      <label class="field">Max. átdolgozási kör <input type="number" min="0" max="10" data-bind="settings.maxRounds" value="${s.maxRounds}"></label>
      <label class="field">Író kontextus (token) <input type="number" min="2048" step="1024" data-bind="settings.writerCtx" value="${s.writerCtx}"></label>
      <label class="field">Lektor kontextus (token) <input type="number" min="2048" step="1024" data-bind="settings.criticCtx" value="${s.criticCtx}"></label>
      <label class="field">Író GPU-rétegek (üres = auto) <input type="number" min="0" step="1" data-bind="settings.writerGpuLayers" value="${s.writerGpuLayers ?? ''}" placeholder="auto"></label>
      <label class="field">Lektor GPU-rétegek (üres = auto) <input type="number" min="0" step="1" data-bind="settings.criticGpuLayers" value="${s.criticGpuLayers ?? ''}" placeholder="auto"></label>
      <label class="field">Író kreativitás (temperature) <input type="number" min="0" max="2" step="0.1" data-bind="settings.temperature" value="${s.temperature}"></label>
    </div>
  </section>

  <div class="actions">
    <button class="btn danger" data-action="delete-project" data-busy>Könyv törlése</button>
    <span class="grow"></span>
    <button class="btn primary" data-action="gen-toc" data-busy>${S.p.toc.chapters.length ? 'Tartalomjegyzék újragenerálása →' : 'Tartalomjegyzék generálása →'}</button>
    ${S.p.toc.chapters.length ? '<button class="btn" data-action="tab" data-tab="toc">Tovább a tartalomjegyzékhez →</button>' : ''}
  </div>
</div>`;
}

// ---------- 2. Tartalomjegyzék ----------
function reviewHtml(r, title) {
  if (!r) return '';
  const list = (t, a) => (a.length ? `<b>${t}</b><ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `<section class="card review-box ${scoreClass(r.score)}">
    <h3>${title}: <span class="score">${r.score}/10</span></h3>
    <p style="margin:4px 0 8px">${esc(r.summary)}</p>
    ${list('Kötelező javítások', r.critical || [])}${list('Problémák', r.issues)}${list('Javaslatok', r.suggestions)}
  </section>`;
}

function tocHtml() {
  const p = S.p;
  const busy = running();
  const dis = busy ? 'disabled' : '';
  const chapters = p.toc.chapters;
  if (!chapters.length) {
    return `<div class="page"><div class="card empty-state">
      <h2>Még nincs tartalomjegyzék</h2>
      <p>Az író modell az „Adatok” fül alapján megtervezi, a lektor pedig véleményezi. Utána szabadon szerkesztheted.</p>
      <div class="actions" style="justify-content:center">
        <button class="btn primary" data-action="gen-toc" data-busy>Tartalomjegyzék generálása</button>
        <button class="btn" data-action="add-chapter" data-busy>Inkább kézzel kezdem</button>
      </div></div></div>`;
  }
  const reqs = reqList();
  const labelOf = new Map(reqs.map(x => [x.req.id, x.label]));
  const covered = new Set(chapters.flatMap(c => c.covers));
  const missing = reqs.filter(x => !covered.has(x.req.id));

  const chHtml = chapters
    .map(
      (ch, ci) => `<section class="card chapter" data-ch="${ch.id}">
      <div class="chapter-head">
        <span class="chapter-num">${ci + 1}.</span>
        <input type="text" data-toc="title" value="${esc(ch.title)}" placeholder="Fejezet címe" ${dis}>
        <div class="row-tools">
          <button class="btn icon" data-action="ch-up" title="Feljebb" ${dis || (ci === 0 ? 'disabled' : '')}>↑</button>
          <button class="btn icon" data-action="ch-down" title="Lejjebb" ${dis || (ci === chapters.length - 1 ? 'disabled' : '')}>↓</button>
          <button class="btn icon danger" data-action="ch-del" title="Fejezet törlése" ${dis}>✕</button>
        </div>
      </div>
      <textarea rows="2" data-toc="summary" placeholder="A fejezet célja, 1–2 mondat" ${dis}>${esc(ch.summary)}</textarea>
      ${
        reqs.length
          ? `<div class="chips" style="margin-top:8px"><span class="muted small-text" style="padding-top:2px">Lefedi:</span>${reqs
              .map(
                x => `<span class="chip ${ch.covers.includes(x.req.id) ? 'on' : ''}" data-action="${busy ? '' : 'cover-toggle'}" data-req="${x.req.id}" title="${esc(x.req.item)}">${x.label} ${esc(x.req.item.slice(0, 28))}</span>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="sections">
        ${ch.sections
          .map(
            (s, si) => `<div class="section-row" data-sec="${s.id}">
            <span class="num">${ci + 1}.${si + 1}</span>
            <div class="fields">
              <input type="text" data-toc="sec-title" value="${esc(s.title)}" placeholder="Szakasz címe" ${dis}>
              <textarea rows="2" data-toc="sec-notes" placeholder="Mi kerüljön bele? (fogalmak, példák, parancsok, feladat)" ${dis}>${esc(s.notes)}</textarea>
              ${s.text ? `<span class="small-text muted">✓ megírva (${fmt(words(s.text))} szó)</span>` : ''}
            </div>
            <div class="row-tools">
              <button class="btn icon" data-action="sec-up" title="Feljebb" ${dis || (si === 0 ? 'disabled' : '')}>↑</button>
              <button class="btn icon" data-action="sec-down" title="Lejjebb" ${dis || (si === ch.sections.length - 1 ? 'disabled' : '')}>↓</button>
              <button class="btn icon danger" data-action="sec-del" title="Szakasz törlése" ${dis}>✕</button>
            </div>
          </div>`,
          )
          .join('')}
      </div>
      <div class="actions" style="margin-left:28px"><button class="btn small" data-action="sec-add" ${dis}>+ Szakasz</button></div>
    </section>`,
    )
    .join('');

  return `<div class="page">
  ${
    p.tocApproved
      ? `<div class="banner">✓ A tartalomjegyzék jóvá van hagyva. Továbbra is szerkesztheted; a már megírt szakaszok szövege megmarad.
          <span class="grow"></span><button class="btn small" data-action="unapprove" data-busy>Jóváhagyás visszavonása</button>
          <button class="btn small primary" data-action="tab" data-tab="write">Írás →</button></div>`
      : ''
  }
  <section class="card toc-toolbar">
    <div class="actions">
      <button class="btn" data-action="gen-toc" data-busy>↻ Újragenerálás</button>
      <button class="btn" data-action="toc-review" data-busy>🔍 Lektor véleményezze</button>
      <button class="btn" data-action="toc-revise-review" data-busy ${p.tocReview ? '' : 'disabled'}>✍ Javítás a lektor alapján</button>
      <span class="grow"></span><span class="save-state"></span>
      ${p.tocApproved ? '' : '<button class="btn primary" data-action="approve" data-busy>✓ Jóváhagyás – indulhat az írás</button>'}
    </div>
    <div class="actions" style="margin-top:10px">
      <textarea id="toc-instr" rows="1" style="flex:1" placeholder="Utasítás az író modellnek, pl. „A DNS kerüljön a DHCP elé, és legyen egy külön hibakeresési fejezet”" ${dis}>${esc(S.tocInstruction)}</textarea>
      <button class="btn" data-action="toc-revise-instr" data-busy>Módosítás utasítással</button>
    </div>
  </section>

  ${reviewHtml(p.tocReview, 'A lektor véleménye')}

  ${
    reqs.length
      ? `<section class="card"><h3>Kötelező elemek lefedettsége ${missing.length ? `<span style="color:var(--bad)">– ${missing.length} elem nincs lefedve</span>` : '<span style="color:var(--ok)">– minden elem lefedve ✓</span>'}</h3>
        <div class="chips">${reqs.map(x => `<span class="chip static ${covered.has(x.req.id) ? 'on' : 'missing'}" title="${esc(x.req.how)}">${x.label} ${esc(x.req.item)}</span>`).join('')}</div>
        <p class="hint" style="margin:8px 0 0">A fejezeteknél a címkékre kattintva állíthatod, melyik fejezet fedi le az adott elemet.</p></section>`
      : ''
  }

  ${chHtml}
  <div class="actions"><button class="btn" data-action="add-chapter" ${dis}>+ Új fejezet</button></div>
</div>`;
}

// ---------- 3. Írás ----------
function allSections() {
  return S.p.toc.chapters.flatMap((ch, ci) => ch.sections.map((sec, si) => ({ ch, sec, ci, si })));
}

function ensureSel() {
  const all = allSections();
  if (S.sel && all.some(x => x.sec.id === S.sel.sec)) return;
  const first = all.find(x => !x.sec.text) || all[0];
  S.sel = first ? { ch: first.ch.id, sec: first.sec.id } : null;
}

function writeShellHtml() {
  if (!S.p.tocApproved) {
    return `<div class="page"><div class="card empty-state">
      <h2>A tartalomjegyzék még nincs jóváhagyva</h2>
      <p>Nézd át és szerkeszd a tartalomjegyzéket, majd hagyd jóvá – utána indulhat a fejezetek írása.</p>
      <button class="btn primary" data-action="tab" data-tab="toc">Tartalomjegyzék →</button></div></div>`;
  }
  return `<div class="write"><aside class="card side" id="side"></aside><div id="secpanel"></div></div>`;
}

function renderSide() {
  const side = $('#side');
  if (!side) return;
  ensureSel();
  const all = allSections();
  const done = all.filter(x => x.sec.text).length;
  const total = words(all.map(x => x.sec.text).join(' '));
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  side.innerHTML = `
    <div class="small-text muted">${done}/${all.length} szakasz · ${fmt(total)} szó</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="actions" style="margin:10px 0 6px">
      <button class="btn primary small" data-action="write-book" data-busy ${done === all.length ? 'disabled' : ''}>▶ Összes hátralévő megírása</button>
    </div>
    <div class="actions" style="margin-bottom:12px">
      <button class="btn small" data-action="export-html">Könyv megnyitása</button>
      <button class="btn small" data-action="export-md">Letöltés (.md)</button>
    </div>
    ${S.p.toc.chapters
      .map(
        (ch, ci) => `<div class="ch-title"><span class="muted">${ci + 1}.</span> ${esc(ch.title)}</div>
        ${ch.sections
          .map(
            (s, si) => `<div class="sec ${S.sel?.sec === s.id ? 'sel' : ''}" data-action="select-sec" data-ch="${ch.id}" data-sec="${s.id}" title="${esc(STATUS[s.status] || '')}">
              <span class="st ${s.status}"></span><span class="t">${ci + 1}.${si + 1} ${esc(s.title)}</span>
              <span class="sc">${s.score != null ? s.score : s.editedByUser && s.text ? '✎' : ''}</span></div>`,
          )
          .join('')}`,
      )
      .join('')}`;
  applyBusy();
}

function renderSecPanel() {
  const panel = $('#secpanel');
  if (!panel) return;
  ensureSel();
  const all = allSections();
  const idx = all.findIndex(x => x.sec.id === S.sel?.sec);
  if (idx < 0) {
    panel.innerHTML = '<div class="card empty-state">A tartalomjegyzékben nincs szakasz.</div>';
    return;
  }
  const { ch, sec, ci, si } = all[idx];
  const isBusy = ['writing', 'reviewing', 'revising'].includes(sec.status);
  const editing = S.editing?.secId === sec.id;
  const chRemaining = ch.sections.filter(s => !s.text).length;
  const reviews = [...(sec.reviews || [])].reverse();

  let body;
  if (editing) {
    body = `<textarea class="editor" id="editor">${esc(S.editing.text)}</textarea>
      <div class="actions end" style="margin-top:10px">
        <button class="btn" data-action="cancel-edit">Mégse</button>
        <button class="btn primary" data-action="save-edit">Mentés</button></div>`;
  } else if (sec.text) {
    body = `<div class="prose">${renderMarkdown(sec.text)}</div>`;
  } else {
    body = `<div class="empty-state">${isBusy ? 'Az író modell dolgozik – a szöveget élőben az alsó naplóban látod.' : 'Ez a szakasz még nincs megírva.'}</div>`;
  }

  panel.innerHTML = `
  <section class="card sec-head">
    <div class="small-text muted">${ci + 1}. fejezet · ${esc(ch.title)}</div>
    <h2>${ci + 1}.${si + 1} ${esc(sec.title)}</h2>
    <div class="meta">
      <span><span class="st ${sec.status}" style="display:inline-block;vertical-align:middle"></span> ${STATUS[sec.status] || sec.status}</span>
      ${sec.text ? `<span>${fmt(words(sec.text))} szó</span>` : ''}
      ${sec.score != null ? `<span class="badge ${scoreClass(sec.score)}">${sec.score}/10</span>` : ''}
      ${sec.editedByUser ? '<span>✎ kézzel szerkesztve</span>' : ''}
      ${sec.reviews?.length ? `<span>${sec.reviews.length} lektori kör</span>` : ''}
    </div>
    ${sec.notes ? `<div class="plan"><b>Terv:</b> ${esc(sec.notes)}</div>` : ''}
    <div class="actions">
      <button class="btn primary" data-action="write-sec" data-busy>${sec.text ? '↻ Újraírás' : '✍ Megírás'}</button>
      <button class="btn" data-action="review-sec" data-busy ${sec.text ? '' : 'disabled'}>🔍 Újralektorálás</button>
      <button class="btn" data-action="edit-sec" data-busy ${editing ? 'disabled' : ''}>✎ Szerkesztés</button>
      <button class="btn" data-action="write-chapter" data-busy ${chRemaining ? '' : 'disabled'}>▶ A fejezet hátralévő ${chRemaining} szakasza</button>
      <span class="grow"></span>
      <button class="btn icon" data-action="nav" data-to="${idx - 1}" ${idx === 0 ? 'disabled' : ''} title="Előző szakasz">‹</button>
      <button class="btn icon" data-action="nav" data-to="${idx + 1}" ${idx === all.length - 1 ? 'disabled' : ''} title="Következő szakasz">›</button>
    </div>
    ${
      sec.text
        ? `<div class="actions" style="margin-top:10px">
        <textarea id="sec-instr" rows="1" style="flex:1" placeholder="Utasítás az átíráshoz, pl. „Legyen benne egy hibakeresési példa a logok alapján”">${esc(S.secInstruction)}</textarea>
        <button class="btn" data-action="rewrite-instr" data-busy>Átírás utasítással</button></div>`
        : ''
    }
  </section>
  <section class="card">${body}</section>
  ${
    reviews.length
      ? `<section class="card reviews"><h3>Lektori vélemények</h3>${reviews
          .map(
            r => `<div class="rv"><span class="badge ${scoreClass(r.score)}">${r.score}/10</span> <span class="muted small-text">${r.round}. kör · ${new Date(r.at).toLocaleString('hu-HU')}</span>
              <p style="margin:6px 0">${esc(r.summary)}</p>
              ${r.critical?.length ? `<b class="small-text" style="color:var(--bad)">Kötelező javítások</b><ul>${r.critical.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              ${r.issues.length ? `<b class="small-text">Problémák</b><ul>${r.issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              ${r.suggestions.length ? `<b class="small-text">Javaslatok</b><ul>${r.suggestions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`,
          )
          .join('')}</section>`
      : ''
  }`;
  applyBusy();
}

// ---------- műveletek ----------
async function startJob(spec) {
  await flush();
  try {
    await api('POST', `/api/projects/${S.p.id}/jobs`, spec);
    openDrawer(true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function setPath(obj, pathStr, val) {
  const keys = pathStr.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = val;
}

function readVal(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? '' : Number(el.value);
  return el.value;
}

function findCh(el) {
  const id = el.closest('[data-ch]')?.dataset.ch;
  return S.p.toc.chapters.find(c => c.id === id);
}

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function onInput(e) {
  const el = e.target;
  if (!S.p) return;
  if (el.dataset.bind) {
    setPath(S.p, el.dataset.bind, readVal(el));
    markDirty(el.dataset.bind.split('.')[0]);
  } else if (el.dataset.reqField) {
    const r = S.p.brief.requirements.find(x => x.id === el.closest('[data-req-id]').dataset.reqId);
    r[el.dataset.reqField] = el.value;
    markDirty('brief');
    if (el.dataset.reqField === 'item') relabelReqs();
  } else if (el.dataset.toc) {
    const ch = findCh(el);
    const secId = el.closest('[data-sec]')?.dataset.sec;
    const sec = ch.sections.find(s => s.id === secId);
    const f = el.dataset.toc;
    if (f === 'title') ch.title = el.value;
    else if (f === 'summary') ch.summary = el.value;
    else if (f === 'sec-title') sec.title = el.value;
    else if (f === 'sec-notes') sec.notes = el.value;
    markDirty('toc');
  } else if (el.id === 'toc-instr') S.tocInstruction = el.value;
  else if (el.id === 'sec-instr') S.secInstruction = el.value;
  else if (el.id === 'editor') S.editing.text = el.value;
}

function relabelReqs() {
  let n = 0;
  document.querySelectorAll('.req').forEach(row => {
    const r = S.p.brief.requirements.find(x => x.id === row.dataset.reqId);
    row.querySelector('.lbl').textContent = r?.item.trim() ? `K${++n}` : '·';
  });
}

const EXAMPLE = {
  title: 'Hálózati szolgáltatások a gyakorlatban',
  topic: 'Hálózati alapszolgáltatások (DHCP, DNS, fájlmegosztás, távoli elérés) működése, telepítése és üzemeltetése Linux és Windows szervereken.',
  audience: 'Technikumi 11–12. évfolyamos informatikus tanulók, akik ismerik az IP-címzés és az OSI-modell alapjait.',
  level: 'középhaladó',
  style: 'Közvetlen, tegező hangnem, sok valós példával; minden beállítást lépésről lépésre mutass be.',
  requirements: [
    { item: 'DHCP szerver', how: 'Elmélet: hogyan működik (DORA folyamat, bérlet, opciók, relay). Beállítás Linuxon (isc-dhcp-server vagy Kea) és Windows Serveren. Gyakorló feladat megoldással.' },
    { item: 'DNS szerver', how: 'Elmélet: névfeloldás menete, rekordtípusok, zónák. Beállítás BIND9-cel. Hibakeresés dig/nslookup segítségével. Gyakorló feladat.' },
    { item: 'Hibakeresés', how: 'Minden szolgáltatásnál legyen tipikus hibák listája és a megoldás lépései.' },
  ],
};

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !el.dataset.action || el.disabled) return;
  const a = el.dataset.action;
  const p = S.p;

  switch (a) {
    case 'tab':
      await flush();
      S.tab = el.dataset.tab;
      render();
      break;
    case 'new-project': {
      await flush();
      const np = await api('POST', '/api/projects', {});
      await loadProjects();
      await openProject(np.id);
      break;
    }
    case 'delete-project':
      if (!confirm(`Biztosan törlöd ezt a könyvet? („${p.brief.title || 'Névtelen'}”) Ez nem vonható vissza.`)) return;
      try {
        S.pending.clear();
        await api('DELETE', `/api/projects/${p.id}`);
        S.p = null;
        await loadProjects();
        if (S.projects[0]) await openProject(S.projects[0].id);
        else render();
      } catch (err) {
        toast(err.message, 'error');
      }
      break;
    case 'fill-example':
      Object.assign(p.brief, { ...EXAMPLE, requirements: EXAMPLE.requirements.map(r => ({ ...r, id: uid('r') })) });
      markDirty('brief');
      renderMain();
      break;
    case 'refresh-models':
      await loadModels(true);
      renderMain();
      break;
    case 'add-req':
      p.brief.requirements.push({ id: uid('r'), item: '', how: '' });
      markDirty('brief');
      renderMain();
      document.querySelector('.req:last-of-type input')?.focus();
      break;
    case 'del-req': {
      const id = el.closest('[data-req-id]').dataset.reqId;
      p.brief.requirements = p.brief.requirements.filter(r => r.id !== id);
      markDirty('brief');
      renderMain();
      break;
    }
    case 'gen-toc':
      if (!p.brief.topic.trim() || !p.brief.audience.trim()) {
        toast('Add meg legalább a témát és a célközönséget.', 'error');
        S.tab = 'brief';
        render();
        return;
      }
      if (p.toc.chapters.length && !confirm('Az új tartalomjegyzék felülírja a jelenlegit (a már megírt, azonos című szakaszok szövege megmarad). Folytatod?')) return;
      S.tab = 'toc';
      render();
      await startJob({ type: 'toc-generate' });
      break;
    case 'toc-review':
      await startJob({ type: 'toc-review' });
      break;
    case 'toc-revise-review':
      await startJob({ type: 'toc-revise', useReview: true, instruction: S.tocInstruction });
      break;
    case 'toc-revise-instr':
      if (!S.tocInstruction.trim()) return toast('Írd be, mit változtasson az író modell.', 'error');
      await startJob({ type: 'toc-revise', instruction: S.tocInstruction });
      S.tocInstruction = '';
      break;
    case 'add-chapter':
      p.toc.chapters.push({ id: uid('c'), title: '', summary: '', covers: [], sections: [{ id: uid('s'), title: '', notes: '', status: 'empty', text: '', reviews: [] }] });
      if (p.phase === 'brief') p.phase = 'toc';
      S.tab = 'toc';
      markDirty('toc');
      render();
      document.querySelector('.chapter:last-of-type input')?.focus();
      break;
    case 'ch-up':
    case 'ch-down': {
      const i = p.toc.chapters.indexOf(findCh(el));
      move(p.toc.chapters, i, a === 'ch-up' ? -1 : 1);
      markDirty('toc');
      renderMain();
      break;
    }
    case 'ch-del': {
      const ch = findCh(el);
      const written = ch.sections.filter(s => s.text).length;
      if (!confirm(`Törlöd a(z) „${ch.title || 'névtelen'}” fejezetet?${written ? ` ${written} megírt szakasz szövege is elvész!` : ''}`)) return;
      p.toc.chapters = p.toc.chapters.filter(c => c !== ch);
      markDirty('toc');
      renderMain();
      break;
    }
    case 'sec-add': {
      const ch = findCh(el);
      ch.sections.push({ id: uid('s'), title: '', notes: '', status: 'empty', text: '', reviews: [] });
      markDirty('toc');
      renderMain();
      document.querySelector(`[data-ch="${ch.id}"] .section-row:last-child input`)?.focus();
      break;
    }
    case 'sec-up':
    case 'sec-down':
    case 'sec-del': {
      const ch = findCh(el);
      const i = ch.sections.findIndex(s => s.id === el.closest('[data-sec]').dataset.sec);
      if (a === 'sec-del') {
        if (ch.sections[i].text && !confirm('Ez a szakasz már meg van írva. Biztosan törlöd?')) return;
        ch.sections.splice(i, 1);
      } else move(ch.sections, i, a === 'sec-up' ? -1 : 1);
      markDirty('toc');
      renderMain();
      break;
    }
    case 'cover-toggle': {
      const ch = findCh(el);
      const id = el.dataset.req;
      ch.covers = ch.covers.includes(id) ? ch.covers.filter(x => x !== id) : [...ch.covers, id];
      markDirty('toc');
      renderMain();
      break;
    }
    case 'approve': {
      await flush();
      const empty = p.toc.chapters.some(c => !c.title.trim() || !c.sections.length || c.sections.some(s => !s.title.trim()));
      if (empty) return toast('Minden fejezetnek és szakasznak legyen címe, és minden fejezetben legyen legalább egy szakasz.', 'error');
      const reqs = reqList();
      const covered = new Set(p.toc.chapters.flatMap(c => c.covers));
      const missing = reqs.filter(x => !covered.has(x.req.id));
      if (missing.length && !confirm(`Ezeket a kötelező elemeket egy fejezet sem fedi le: ${missing.map(x => x.label).join(', ')}. Így is jóváhagyod?`)) return;
      try {
        S.p = await api('PUT', `/api/projects/${p.id}`, { tocApproved: true });
        S.tab = 'write';
        render();
        toast('Jóváhagyva – indulhat az írás!', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      break;
    }
    case 'unapprove':
      try {
        S.p = await api('PUT', `/api/projects/${p.id}`, { tocApproved: false });
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
      break;
    case 'select-sec':
      if (S.editing && !confirm('A szerkesztett szöveg nincs mentve. Elveted?')) return;
      S.editing = null;
      S.sel = { ch: el.dataset.ch, sec: el.dataset.sec };
      renderSide();
      renderSecPanel();
      $('#main').scrollTop = 0;
      break;
    case 'nav': {
      const t = allSections()[Number(el.dataset.to)];
      if (!t) return;
      if (S.editing && !confirm('A szerkesztett szöveg nincs mentve. Elveted?')) return;
      S.editing = null;
      S.sel = { ch: t.ch.id, sec: t.sec.id };
      renderSide();
      renderSecPanel();
      $('#main').scrollTop = 0;
      break;
    }
    case 'write-sec': {
      const sec = allSections().find(x => x.sec.id === S.sel.sec).sec;
      if (sec.text && !confirm('A szakasz újraírása lecseréli a jelenlegi szöveget. Folytatod?')) return;
      await startJob({ type: 'section', chapterId: S.sel.ch, sectionId: S.sel.sec });
      break;
    }
    case 'rewrite-instr':
      if (!S.secInstruction.trim()) return toast('Írd be, mit változtasson az író modell.', 'error');
      await startJob({ type: 'section', chapterId: S.sel.ch, sectionId: S.sel.sec, instruction: S.secInstruction });
      S.secInstruction = '';
      break;
    case 'review-sec':
      await startJob({ type: 'section-review', chapterId: S.sel.ch, sectionId: S.sel.sec });
      break;
    case 'write-chapter':
      await startJob({ type: 'chapter', chapterId: S.sel.ch });
      break;
    case 'write-book':
      await startJob({ type: 'book' });
      break;
    case 'edit-sec': {
      const sec = allSections().find(x => x.sec.id === S.sel.sec).sec;
      S.editing = { secId: sec.id, text: sec.text || '' };
      renderSecPanel();
      $('#editor')?.focus();
      break;
    }
    case 'cancel-edit':
      S.editing = null;
      renderSecPanel();
      break;
    case 'save-edit':
      try {
        S.p = await api('PUT', `/api/projects/${p.id}/sections/${S.sel.ch}/${S.sel.sec}`, { text: S.editing.text });
        S.editing = null;
        renderSide();
        renderSecPanel();
        toast('Mentve.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      break;
    case 'export-html':
      window.open(`/api/projects/${p.id}/export?format=html`, '_blank');
      break;
    case 'export-md':
      location.href = `/api/projects/${p.id}/export?format=md&download`;
      break;
  }
}

// ---------- indulás ----------
function bindGlobal() {
  const main = $('#main');
  main.addEventListener('input', onInput);
  main.addEventListener('change', e => {
    if (e.target.matches('select, input[type=checkbox]')) onInput(e);
  });
  document.addEventListener('click', onClick);
  $('#tabs').addEventListener('click', async e => {
    const b = e.target.closest('button[data-tab]');
    if (!b || b.disabled) return;
    await flush();
    S.tab = b.dataset.tab;
    render();
  });
  $('#project-select').addEventListener('change', e => e.target.value && openProject(e.target.value));
  $('#drawer-toggle').addEventListener('click', () => openDrawer($('#drawer').classList.contains('collapsed')));
  $('#stop-job').addEventListener('click', () => api('POST', '/api/jobs/stop').catch(err => toast(err.message, 'error')));
  $('#log').addEventListener('scroll', e => {
    const l = e.target;
    stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  });
  window.addEventListener('beforeunload', () => {
    if (S.pending.size) flush();
  });
}

async function init() {
  bindGlobal();
  connectEvents();
  renderOllama();
  await Promise.all([loadModels(), loadProjects()]);
  const last = store.get('ari.project');
  const id = S.projects.find(x => x.id === last)?.id || S.projects[0]?.id;
  if (id) await openProject(id);
  else render();
  applyHash();
}

// Közvetlen link egy fülre vagy szakaszra: #brief, #toc, #write, #write/<szakasz-azonosító>
function applyHash() {
  const [tab, secId] = location.hash.slice(1).split('/');
  if (!S.p || !['brief', 'toc', 'write'].includes(tab)) return;
  S.tab = tab;
  const hit = secId && allSections().find(x => x.sec.id === secId);
  if (hit) S.sel = { ch: hit.ch.id, sec: hit.sec.id };
  render();
}

init().catch(e => toast(e.message, 'error', 10000));
