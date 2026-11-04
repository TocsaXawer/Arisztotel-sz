// Projektek tárolása: projects/<id>.json, memóriabeli gyorsítótárral.
import { readFile, writeFile, rename, readdir, unlink, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A könyvek helye; PROJECTS_DIR környezeti változóval máshová tehető.
const DIR = process.env.PROJECTS_DIR
  ? path.resolve(process.env.PROJECTS_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects');
const cache = new Map();
const saveChains = new Map();

export const ID_RE = /^[a-z0-9_-]{4,64}$/i;

export function newId(prefix = '') {
  return prefix + randomBytes(5).toString('hex');
}

export function defaultProject() {
  const now = new Date().toISOString();
  return {
    id: newId('k'),
    createdAt: now,
    updatedAt: now,
    phase: 'brief', // brief → toc → writing
    brief: {
      title: '',
      topic: '',
      audience: '',
      level: 'kezdő',
      language: 'magyar',
      style: '',
      chapterCount: 8,
      wordsPerSection: 700,
      extras: { exercises: true, solutions: true, questions: true, summary: true },
      requirements: [],
      notes: '',
    },
    settings: {
      writerModel: 'gemma4:26b',
      criticModel: 'qwen3.5:latest',
      swapModels: true,
      writerThink: false,
      criticThink: false,
      maxRounds: 2,
      passScore: 8,
      writerGpuLayers: null, // null = automatikus; memóriahiánynál a program csökkenti
      criticGpuLayers: null,
      writerCtx: 16384,
      criticCtx: 16384,
      temperature: 0.7,
    },
    toc: { chapters: [] },
    tocReview: null,
    tocApproved: false,
  };
}

const BUSY = new Set(['writing', 'reviewing', 'revising']);

// Betöltéskor a félbemaradt állapotokat (pl. szerver újraindítás) helyreállítjuk.
function normalize(p) {
  const base = defaultProject();
  p.brief = { ...base.brief, ...p.brief, extras: { ...base.brief.extras, ...p.brief?.extras } };
  p.settings = { ...base.settings, ...p.settings };
  p.toc ||= { chapters: [] };
  for (const ch of p.toc.chapters) {
    ch.covers ||= [];
    for (const s of ch.sections) {
      s.reviews ||= [];
      if (BUSY.has(s.status)) s.status = s.text ? 'review' : 'empty';
    }
  }
  return p;
}

function file(id) {
  if (!ID_RE.test(id)) throw Object.assign(new Error('Érvénytelen azonosító'), { status: 400 });
  return path.join(DIR, `${id}.json`);
}

export async function get(id) {
  if (cache.has(id)) return cache.get(id);
  let raw;
  try {
    raw = await readFile(file(id), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('Nincs ilyen projekt'), { status: 404 });
    throw e;
  }
  const p = normalize(JSON.parse(raw));
  cache.set(id, p);
  return p;
}

export function save(p) {
  p.updatedAt = new Date().toISOString();
  const prev = saveChains.get(p.id) || Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(DIR, { recursive: true });
    const target = file(p.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2));
    await rename(tmp, target);
  });
  saveChains.set(p.id, next.catch(() => {}));
  return next;
}

export async function create(overrides = {}) {
  const p = defaultProject();
  Object.assign(p.brief, overrides.brief || {});
  Object.assign(p.settings, overrides.settings || {});
  cache.set(p.id, p);
  await save(p);
  return p;
}

export async function remove(id) {
  cache.delete(id);
  await unlink(file(id)).catch(e => {
    if (e.code !== 'ENOENT') throw e;
  });
}

export async function list() {
  await mkdir(DIR, { recursive: true });
  const files = (await readdir(DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const p = await get(f.slice(0, -5));
      const secs = p.toc.chapters.flatMap(c => c.sections);
      out.push({
        id: p.id,
        title: p.brief.title || p.brief.topic.slice(0, 60) || 'Névtelen könyv',
        phase: p.phase,
        updatedAt: p.updatedAt,
        sections: secs.length,
        written: secs.filter(s => s.text).length,
      });
    } catch {
      /* sérült fájl: kihagyjuk */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
