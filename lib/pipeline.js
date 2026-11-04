// A munkafolyamatok: tartalomjegyzék generálás/lektorálás/átdolgozás, szakaszok írása író–lektor körökkel.
import * as ollama from './ollama.js';
import * as P from './prompts.js';
import { newId } from './store.js';

export async function runJob(ctx, spec) {
  switch (spec.type) {
    case 'toc-generate':
      return tocGenerate(ctx);
    case 'toc-review':
      return tocReview(ctx);
    case 'toc-revise':
      return tocRevise(ctx, spec);
    case 'section':
      return sectionJob(ctx, spec.chapterId, spec.sectionId, spec);
    case 'section-review':
      return sectionReviewOnly(ctx, spec.chapterId, spec.sectionId);
    case 'chapter':
      return chapterJob(ctx, spec.chapterId, spec);
    case 'book':
      return bookJob(ctx);
    default:
      throw Object.assign(new Error(`Ismeretlen feladat: ${spec.type}`), { status: 400 });
  }
}

export function describe(p, spec) {
  const loc = () => {
    const ci = p.toc.chapters.findIndex(c => c.id === spec.chapterId);
    const ch = p.toc.chapters[ci];
    if (!ch) return '';
    if (!spec.sectionId) return `${ci + 1}. fejezet`;
    const si = ch.sections.findIndex(s => s.id === spec.sectionId);
    return `${ci + 1}.${si + 1} ${ch.sections[si]?.title || ''}`;
  };
  return (
    {
      'toc-generate': 'Tartalomjegyzék generálása',
      'toc-review': 'Tartalomjegyzék lektorálása',
      'toc-revise': 'Tartalomjegyzék átdolgozása',
      section: `Szakasz írása: ${loc()}`,
      'section-review': `Szakasz lektorálása: ${loc()}`,
      chapter: `Fejezet írása: ${loc()}`,
      book: 'A teljes könyv (hátralévő szakaszok) írása',
    }[spec.type] || spec.type
  );
}

// ---------- modellhívások ----------

const evictFor = (s, model) => (s.swapModels ? [s.writerModel, s.criticModel].filter(m => m !== model) : []);

/**
 * Modellhívás memóriahiány esetén automatikus visszalépéssel: ha a válasz megszakad (GPU OOM),
 * kevesebb réteget teszünk a GPU-ra (a többi a CPU-n fut), és a működő értéket elmentjük.
 */
async function runModel(ctx, role, params) {
  const s = ctx.project.settings;
  const key = role === 'writer' ? 'writerGpuLayers' : 'criticGpuLayers';
  for (let attempt = 0; ; attempt++) {
    const options = { ...params.options };
    if (Number.isInteger(s[key])) options.num_gpu = s[key];
    try {
      return await ollama.chat({ ...params, options });
    } catch (e) {
      if (!e.oom || attempt >= 3 || ctx.signal.aborted) throw e;
      const layers = await ollama.layerCount(params.model);
      const cur = Number.isInteger(s[key]) ? s[key] : layers;
      s[key] = Math.max(0, Math.floor(cur * 0.8));
      await ollama.unload(params.model);
      await ctx.save();
      ctx.status(`Memóriahiány (${params.model}) – újrapróbálás ${s[key]}/${layers} GPU-réteggel; a többi a CPU-n fut, ez lassabb. Az érték a beállításokban megmarad.`);
    }
  }
}

async function callWriter(ctx, messages, title, format) {
  const s = ctx.project.settings;
  const st = ctx.stream('writer', s.writerModel, title);
  const res = await runModel(ctx, 'writer', {
    model: s.writerModel,
    evict: evictFor(s, s.writerModel),
    messages,
    format,
    think: s.writerThink,
    options: { num_ctx: Number(s.writerCtx) || 16384, temperature: format ? 0.4 : Number(s.temperature) },
    signal: ctx.signal,
    onToken: st.token,
    onThinking: st.thinking,
  });
  return res.content;
}

async function callCritic(ctx, messages, title, format = P.REVIEW_SCHEMA) {
  const s = ctx.project.settings;
  const st = ctx.stream('critic', s.criticModel, title);
  const res = await runModel(ctx, 'critic', {
    model: s.criticModel,
    evict: evictFor(s, s.criticModel),
    messages,
    format,
    think: s.criticThink,
    options: { num_ctx: Number(s.criticCtx) || 16384, temperature: 0.2 },
    signal: ctx.signal,
    onToken: st.token,
    onThinking: st.thinking,
  });
  return res.content;
}

function parseJson(text) {
  let t = String(text || '').trim();
  if (!t) throw new Error('A modell üres választ adott (JSON-t vártunk).');
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('A modell nem érvényes JSON-t adott vissza.');
  }
}

function toReview(raw) {
  const j = parseJson(raw);
  const arr = x => (Array.isArray(x) ? x.map(String).filter(s => s.trim()) : []);
  let score = Math.round(Number(j.score));
  if (!Number.isFinite(score)) score = 5;
  score = Math.max(1, Math.min(10, score));
  return {
    score,
    summary: String(j.summary || ''),
    critical: arr(j.critical),
    issues: arr(j.issues),
    suggestions: arr(j.suggestions),
    at: new Date().toISOString(),
  };
}

// Kínai/japán/koreai, cirill, arab, héber, thai, dévanágari karakterek – latin betűs könyvben biztosan hibát jeleznek.
const FOREIGN_SCRIPT = /[\u0400-\u04ff\u0590-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/gu;

/** Gépi ellenőrzések, amelyeket nem bízunk a kis modellre. */
function autoCritical(p, text) {
  const out = [];
  if (!/orosz|ukrán|szerb|bolgár|kínai|japán|koreai|arab|héber|görög|russian|chinese|japanese/i.test(p.brief.language)) {
    const hits = [...new Set([...String(text).matchAll(FOREIGN_SCRIPT)].map(m => m[0]))];
    for (const h of hits.slice(0, 5)) {
      const i = text.indexOf(h);
      const around = text.slice(Math.max(0, i - 30), i + h.length + 30).replace(/\s+/g, ' ');
      out.push(`Idegen írásrendszerű karakterek a szövegben: „${h}” (környezet: „…${around}…”). Cseréld helyes ${p.brief.language} szóra.`);
    }
  }
  if (text.includes('<!-- Figyelem: a modell elérte')) out.push('A szöveg csonka: a modell elérte a kimeneti korlátot. Fejezd be a szakaszt rövidebben.');
  return out;
}

function cleanSection(text, title) {
  let t = String(text || '').trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) t = fence[1].trim();
  // ha a modell mégis kiírta a szakasz címét címsorként, levágjuk
  const first = t.split('\n', 1)[0];
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (/^#{1,6}\s/.test(first) && norm(first.replace(/^#+\s*(\d+(\.\d+)*\.?\s*)?/, '')) === norm(title)) {
    t = t.slice(first.length).trim();
  }
  return t;
}

// ---------- tartalomjegyzék ----------

function buildToc(p, data) {
  const reqs = P.reqList(p);
  const byLabel = new Map(reqs.map(x => [x.label, x.req.id]));
  const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // korábbi szakaszok cím szerint, hogy a már megírt szöveg megmaradjon
  const old = new Map();
  for (const ch of p.toc.chapters) for (const s of ch.sections) if (s.text) old.set(norm(s.title), s);

  const mapCover = c => {
    const m = String(c).toUpperCase().match(/K\s*(\d+)/);
    if (m && byLabel.has(`K${m[1]}`)) return byLabel.get(`K${m[1]}`);
    const hit = reqs.find(x => norm(c).includes(norm(x.req.item)) || norm(x.req.item).includes(norm(c)));
    return hit?.req.id;
  };

  const chapters = (data.chapters || []).map(c => ({
    id: newId('c'),
    title: String(c.title || '').trim() || 'Névtelen fejezet',
    summary: String(c.summary || '').trim(),
    covers: [...new Set((c.covers || []).map(mapCover).filter(Boolean))],
    digest: '',
    sections: (c.sections || []).map(s => {
      const title = String(s.title || '').trim() || 'Névtelen szakasz';
      const prev = old.get(norm(title));
      if (prev) {
        old.delete(norm(title));
        return { ...prev, title, notes: String(s.notes || '').trim() };
      }
      return { id: newId('s'), title, notes: String(s.notes || '').trim(), status: 'empty', text: '', score: null, reviews: [] };
    }),
  }));
  if (!chapters.length) throw new Error('A modell üres tartalomjegyzéket adott vissza.');
  return chapters;
}

async function tocGenerate(ctx) {
  const p = ctx.project;
  ctx.status('Az író modell megtervezi a tartalomjegyzéket…');
  const raw = await callWriter(ctx, P.tocGenerateMessages(p), 'Tartalomjegyzék', P.TOC_SCHEMA);
  p.toc.chapters = buildToc(p, parseJson(raw));
  p.tocReview = null;
  p.tocApproved = false;
  p.phase = 'toc';
  await ctx.save();
  ctx.status(`Kész: ${p.toc.chapters.length} fejezet.`);
  await tocReview(ctx);
}

async function tocReview(ctx) {
  const p = ctx.project;
  if (!p.toc.chapters.length) throw new Error('Még nincs tartalomjegyzék.');
  ctx.status('A lektor modell értékeli a tartalomjegyzéket…');
  const review = toReview(await callCritic(ctx, P.tocReviewMessages(p), 'Tartalomjegyzék lektorálása'));
  p.tocReview = review;
  await ctx.save();
  ctx.status(`Lektori pontszám: ${review.score}/10`);
}

async function tocRevise(ctx, { instruction, useReview }) {
  const p = ctx.project;
  if (!p.toc.chapters.length) throw new Error('Még nincs tartalomjegyzék.');
  ctx.status('Az író modell átdolgozza a tartalomjegyzéket…');
  const review = useReview ? p.tocReview : null;
  const raw = await callWriter(ctx, P.tocReviseMessages(p, { review, instruction }), 'Tartalomjegyzék átdolgozása', P.TOC_SCHEMA);
  p.toc.chapters = buildToc(p, parseJson(raw));
  p.tocReview = null;
  await ctx.save();
  await tocReview(ctx);
}

// ---------- szakaszok ----------

function locate(p, chapterId, sectionId) {
  const ci = p.toc.chapters.findIndex(c => c.id === chapterId);
  if (ci < 0) throw Object.assign(new Error('Nincs ilyen fejezet'), { status: 404 });
  const ch = p.toc.chapters[ci];
  if (!sectionId) return { ci, ch };
  const si = ch.sections.findIndex(s => s.id === sectionId);
  if (si < 0) throw Object.assign(new Error('Nincs ilyen szakasz'), { status: 404 });
  return { ci, ch, si, sec: ch.sections[si] };
}

const settledStatus = (sec, pass) =>
  !sec.text ? 'empty' : sec.score == null || (sec.score >= pass && !sec.openCritical) ? 'done' : 'review';
// rangsor a legjobb változat kiválasztásához: a kötelező javítások erősen lehúzzák
const rank = r => r.score - 3 * r.critical.length;

async function review(ctx, ci, si, text) {
  const p = ctx.project;
  const label = `${ci + 1}.${si + 1}`;
  const r = toReview(await callCritic(ctx, P.sectionReviewMessages(p, ci, si, text), `Lektorálás – ${label}`));
  const auto = autoCritical(p, text);
  if (auto.length) {
    r.critical.unshift(...auto);
    ctx.status(`${label}: gépi ellenőrzés – ${auto.length} kötelező javítás`);
  }
  return r;
}

async function writeSection(ctx, chapterId, sectionId, { instruction } = {}) {
  const p = ctx.project;
  const { ci, si, sec, ch } = locate(p, chapterId, sectionId);
  const pass = Number(p.settings.passScore) || 8;
  const maxRounds = Math.max(0, Number(p.settings.maxRounds) || 0);
  const label = `${ci + 1}.${si + 1} ${sec.title}`;

  try {
    let text;
    if (instruction?.trim() && sec.text) {
      sec.status = 'revising';
      await ctx.save();
      ctx.status(`${label}: átírás a szerző utasítása alapján…`);
      text = cleanSection(await callWriter(ctx, P.sectionReviseMessages(p, ci, si, sec.text, { instruction }), `Átírás – ${label}`), sec.title);
    } else {
      sec.status = 'writing';
      await ctx.save();
      ctx.status(`${label}: írás…`);
      text = cleanSection(await callWriter(ctx, P.sectionWriteMessages(p, ci, si), `Írás – ${label}`), sec.title);
    }

    let best = null;
    for (let round = 0; ; round++) {
      sec.status = 'reviewing';
      await ctx.save();
      ctx.status(`${label}: lektorálás (${round + 1}. kör)…`);
      const r = { ...(await review(ctx, ci, si, text)), round: round + 1 };
      sec.reviews.push(r);
      if (!best || rank(r) >= best.rank) best = { text, score: r.score, rank: rank(r), critical: r.critical.length };
      sec.text = best.text;
      sec.score = best.score;
      sec.openCritical = best.critical;
      sec.editedByUser = false;
      ch.digestStale = true;
      await ctx.save();
      ctx.status(`${label}: ${r.score}/10${r.critical.length ? `, ${r.critical.length} kötelező javítás` : ''}`);
      if ((r.score >= pass && !r.critical.length) || round >= maxRounds) break;

      sec.status = 'revising';
      await ctx.save();
      ctx.status(`${label}: átdolgozás a lektor alapján…`);
      text = cleanSection(
        await callWriter(ctx, P.sectionReviseMessages(p, ci, si, text, { review: r, instruction }), `Átdolgozás – ${label}`),
        sec.title,
      );
    }
    sec.status = settledStatus(sec, pass);
    await ctx.save();
  } catch (e) {
    sec.status = settledStatus(sec, pass);
    await ctx.save();
    throw e;
  }
}

async function maybeDigest(ctx, ci) {
  const p = ctx.project;
  const ch = p.toc.chapters[ci];
  if (!ch.sections.length || ch.sections.some(s => !s.text)) return;
  if (ch.digest && !ch.digestStale) return;
  ctx.status(`${ci + 1}. fejezet összefoglalása a további fejezetekhez…`);
  const s = p.settings;
  const st = ctx.stream('critic', s.criticModel, `Összefoglaló – ${ci + 1}. fejezet`);
  const res = await runModel(ctx, 'critic', {
    model: s.criticModel,
    evict: evictFor(s, s.criticModel),
    messages: P.chapterDigestMessages(p, ci),
    think: false,
    options: { num_ctx: Number(s.criticCtx) || 16384, temperature: 0.2 },
    signal: ctx.signal,
    onToken: st.token,
  });
  ch.digest = res.content.trim();
  ch.digestStale = false;
  await ctx.save();
}

async function sectionJob(ctx, chapterId, sectionId, spec) {
  await writeSection(ctx, chapterId, sectionId, spec);
  await maybeDigest(ctx, locate(ctx.project, chapterId).ci);
}

async function sectionReviewOnly(ctx, chapterId, sectionId) {
  const p = ctx.project;
  const { ci, si, sec } = locate(p, chapterId, sectionId);
  if (!sec.text) throw new Error('A szakasz még üres.');
  const pass = Number(p.settings.passScore) || 8;
  sec.status = 'reviewing';
  await ctx.save();
  try {
    const r = { ...(await review(ctx, ci, si, sec.text)), round: (sec.reviews.at(-1)?.round || 0) + 1 };
    sec.reviews.push(r);
    sec.score = r.score;
    sec.openCritical = r.critical.length;
  } finally {
    sec.status = settledStatus(sec, pass);
    await ctx.save();
  }
}

async function chapterJob(ctx, chapterId, { rewrite } = {}) {
  const { ci, ch } = locate(ctx.project, chapterId);
  for (const sec of [...ch.sections]) {
    if (!rewrite && sec.text) continue;
    await writeSection(ctx, chapterId, sec.id);
  }
  await maybeDigest(ctx, ci);
}

async function bookJob(ctx) {
  const p = ctx.project;
  for (const ch of [...p.toc.chapters]) {
    const ci = p.toc.chapters.indexOf(ch);
    if (ci < 0) continue;
    for (const sec of [...ch.sections]) {
      if (sec.text) continue;
      await writeSection(ctx, ch.id, sec.id);
    }
    await maybeDigest(ctx, ci);
  }
  ctx.status('A könyv minden szakasza elkészült.');
}
