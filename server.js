// Arisztotelész – könyvíró program helyi Ollama modellekkel.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import * as ollama from './lib/ollama.js';
import * as jobs from './lib/jobs.js';
import { exportMarkdown, exportHtml } from './lib/export.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5577;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const fail = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, data, type = 'application/json; charset=utf-8', extra = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw fail(413, 'Túl nagy kérés');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(400, 'Hibás JSON');
  }
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Tiltott', 'text/plain');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, 'Nem található', 'text/plain; charset=utf-8');
  }
}

const str = (v, max = 20000) => String(v ?? '').slice(0, max);
const ID = /^[a-z0-9_-]{2,64}$/i;

/**
 * A kliens által szerkesztett tartalomjegyzék beolvasztása. A megírt szövegek, pontszámok
 * és lektori vélemények mindig a szerver példányából jönnek (azonosító alapján).
 */
function mergeToc(p, incoming) {
  if (!Array.isArray(incoming?.chapters)) throw fail(400, 'Hibás tartalomjegyzék');
  const oldCh = new Map(p.toc.chapters.map(c => [c.id, c]));
  const oldSec = new Map(p.toc.chapters.flatMap(c => c.sections.map(s => [s.id, s])));
  const reqIds = new Set(p.brief.requirements.map(r => r.id));
  p.toc.chapters = incoming.chapters.map(c => {
    const prev = ID.test(c.id) ? oldCh.get(c.id) : null;
    return {
      id: prev?.id || (ID.test(c.id) ? c.id : store.newId('c')),
      title: str(c.title, 300),
      summary: str(c.summary, 3000),
      covers: [...new Set((c.covers || []).filter(id => reqIds.has(id)))],
      digest: prev?.digest || '',
      digestStale: prev?.digestStale || false,
      sections: (c.sections || []).map(s => {
        const ps = ID.test(s.id) ? oldSec.get(s.id) : null;
        const base = ps || { id: ID.test(s.id) ? s.id : store.newId('s'), status: 'empty', text: '', score: null, reviews: [] };
        return { ...base, title: str(s.title, 300), notes: str(s.notes, 5000) };
      }),
    };
  });
}

function mergeBrief(p, b) {
  const t = p.brief;
  for (const k of ['title', 'topic', 'audience', 'level', 'language', 'style', 'notes']) if (k in b) t[k] = str(b[k], 10000);
  if ('chapterCount' in b) t.chapterCount = Math.max(1, Math.min(60, Number(b.chapterCount) || 8));
  if ('wordsPerSection' in b) t.wordsPerSection = Math.max(100, Math.min(5000, Number(b.wordsPerSection) || 700));
  if (b.extras) for (const k of Object.keys(t.extras)) if (k in b.extras) t.extras[k] = Boolean(b.extras[k]);
  if (Array.isArray(b.requirements)) {
    t.requirements = b.requirements.map(r => ({
      id: ID.test(r.id) ? r.id : store.newId('r'),
      item: str(r.item, 500),
      how: str(r.how, 3000),
    }));
  }
}

function mergeSettings(p, s) {
  const t = p.settings;
  for (const k of ['writerModel', 'criticModel']) if (k in s) t[k] = str(s[k], 200);
  for (const k of ['writerThink', 'criticThink', 'swapModels']) if (k in s) t[k] = Boolean(s[k]);
  const num = (k, lo, hi) => {
    if (k in s && Number.isFinite(Number(s[k]))) t[k] = Math.max(lo, Math.min(hi, Number(s[k])));
  };
  num('maxRounds', 0, 10);
  num('passScore', 1, 10);
  num('writerCtx', 2048, 262144);
  num('criticCtx', 2048, 262144);
  num('temperature', 0, 2);
  for (const k of ['writerGpuLayers', 'criticGpuLayers']) {
    if (!(k in s)) continue;
    const v = s[k] === '' || s[k] == null ? null : Math.round(Number(s[k]));
    t[k] = Number.isInteger(v) && v >= 0 && v <= 999 ? v : null;
  }
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' nélkül
  const method = req.method;

  if (parts[0] === 'events' && method === 'GET') return jobs.addClient(res);

  if (parts[0] === 'models' && method === 'GET') {
    try {
      return send(res, 200, { ok: true, host: ollama.HOST, models: await ollama.listModels(url.searchParams.has('refresh')) });
    } catch (e) {
      return send(res, 200, { ok: false, host: ollama.HOST, error: e.message, models: [] });
    }
  }

  if (parts[0] === 'jobs') {
    if (parts[1] === 'stop' && method === 'POST') return send(res, 200, { stopped: jobs.stop() });
    if (!parts[1] && method === 'GET') return send(res, 200, { job: jobs.currentJob() });
  }

  if (parts[0] === 'projects') {
    const id = parts[1];
    if (!id) {
      if (method === 'GET') return send(res, 200, await store.list());
      if (method === 'POST') return send(res, 201, await store.create(await readBody(req)));
    }
    if (id && !store.ID_RE.test(id)) throw fail(400, 'Érvénytelen azonosító');

    if (id && parts.length === 2) {
      if (method === 'GET') return send(res, 200, await store.get(id));
      if (method === 'DELETE') {
        if (jobs.isBusy(id)) throw fail(409, 'Ezen a projekten éppen fut egy feladat.');
        await store.remove(id);
        return send(res, 200, { ok: true });
      }
      if (method === 'PUT') {
        const p = await store.get(id);
        const b = await readBody(req);
        const touchesToc = 'toc' in b || 'tocApproved' in b;
        if (touchesToc && jobs.isBusy(id)) throw fail(409, 'Feladat fut – a tartalomjegyzék most nem módosítható.');
        if (b.brief) mergeBrief(p, b.brief);
        if (b.settings) mergeSettings(p, b.settings);
        if (b.toc) {
          mergeToc(p, b.toc);
          if (p.phase === 'brief' && p.toc.chapters.length) p.phase = 'toc';
        }
        if ('tocApproved' in b) {
          p.tocApproved = Boolean(b.tocApproved);
          if (p.tocApproved) p.phase = 'writing';
          else if (p.phase === 'writing') p.phase = 'toc';
        }
        await store.save(p);
        return send(res, 200, p);
      }
    }

    if (id && parts[2] === 'sections' && parts[3] && parts[4] && method === 'PUT') {
      if (jobs.isBusy(id)) throw fail(409, 'Feladat fut – a szöveg most nem módosítható.');
      const p = await store.get(id);
      const ch = p.toc.chapters.find(c => c.id === parts[3]);
      const sec = ch?.sections.find(s => s.id === parts[4]);
      if (!sec) throw fail(404, 'Nincs ilyen szakasz');
      const b = await readBody(req);
      sec.text = str(b.text, 500000);
      sec.score = null;
      sec.openCritical = 0;
      sec.editedByUser = true;
      sec.status = sec.text.trim() ? 'done' : 'empty';
      ch.digestStale = true;
      await store.save(p);
      return send(res, 200, p);
    }

    if (id && parts[2] === 'jobs' && method === 'POST') {
      const spec = await readBody(req);
      const p = await store.get(id);
      if (['section', 'section-review', 'chapter', 'book'].includes(spec.type) && !p.tocApproved) {
        throw fail(400, 'Előbb hagyd jóvá a tartalomjegyzéket.');
      }
      return send(res, 202, await jobs.start(id, spec));
    }

    if (id && parts[2] === 'export' && method === 'GET') {
      const p = await store.get(id);
      const base = (p.brief.title || 'konyv').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'konyv';
      const html = url.searchParams.get('format') === 'html';
      const disp = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${base}.${html ? 'html' : 'md'}"` } : {};
      return html
        ? send(res, 200, exportHtml(p), 'text/html; charset=utf-8', disp)
        : send(res, 200, exportMarkdown(p), 'text/markdown; charset=utf-8', disp);
    }
  }

  throw fail(404, 'Ismeretlen végpont');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(url.pathname, res);
  } catch (e) {
    if (e.status >= 500 || !e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Arisztotelész fut: http://localhost:${PORT}  (Ollama: ${ollama.HOST})`);
});
