// Az író és a lektor modell promptjai.

export const TOC_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          covers: { type: 'array', items: { type: 'string' } },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, notes: { type: 'string' } },
              required: ['title', 'notes'],
            },
          },
        },
        required: ['title', 'summary', 'covers', 'sections'],
      },
    },
  },
  required: ['chapters'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    summary: { type: 'string' },
    critical: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'summary', 'critical', 'issues', 'suggestions'],
};

/** A kitöltött kötelező elemek, K1, K2… címkékkel. */
export function reqList(p) {
  return p.brief.requirements
    .filter(r => r.item && r.item.trim())
    .map((r, i) => ({ label: `K${i + 1}`, req: r }));
}

function extrasText(b) {
  const e = b.extras || {};
  const parts = [];
  if (e.exercises) parts.push(e.solutions ? 'gyakorló feladatok megoldással' : 'gyakorló feladatok (megoldás nélkül)');
  if (e.questions) parts.push('ellenőrző kérdések');
  if (e.summary) parts.push('rövid összefoglaló');
  return parts.length ? `Minden fejezet végén legyen: ${parts.join(', ')}.` : '';
}

export function briefBlock(p) {
  const b = p.brief;
  const L = [];
  L.push(`Munkacím: ${b.title || '(nincs megadva – javasolhatsz)'}`);
  L.push(`Téma, cél: ${b.topic || '-'}`);
  L.push(`Célközönség (kinek szól): ${b.audience || '-'}`);
  L.push(`Szint: ${b.level}`);
  L.push(`A könyv nyelve: ${b.language}`);
  if (b.style) L.push(`Stílus, hangnem: ${b.style}`);
  const ex = extrasText(b);
  if (ex) L.push(ex);
  const reqs = reqList(p);
  if (reqs.length) {
    L.push('', 'KÖTELEZŐ TARTALMI ELEMEK (mindegyiknek szerepelnie kell a könyvben, a megadott módon):');
    for (const { label, req } of reqs) {
      L.push(`[${label}] ${req.item.trim()}${req.how?.trim() ? `\n     Hogyan: ${req.how.trim()}` : ''}`);
    }
  }
  if (b.notes?.trim()) L.push('', `Egyéb kérések: ${b.notes.trim()}`);
  return L.join('\n');
}

/** Tartalomjegyzék szövegesen; a marker egy szakaszt jelöl ki. */
export function tocText(p, { notes = false, mark = null } = {}) {
  const labels = new Map(reqList(p).map(x => [x.req.id, x.label]));
  const L = [];
  p.toc.chapters.forEach((ch, ci) => {
    const cov = ch.covers.map(id => labels.get(id)).filter(Boolean);
    L.push(`${ci + 1}. fejezet: ${ch.title}${cov.length ? `  [lefedi: ${cov.join(', ')}]` : ''}`);
    if (notes && ch.summary) L.push(`   Összefoglaló: ${ch.summary}`);
    ch.sections.forEach((s, si) => {
      const here = mark && mark === s.id ? '   ◄◄ EZT A SZAKASZT ÍROD MOST' : '';
      L.push(`   ${ci + 1}.${si + 1} ${s.title}${here}`);
      if (notes && s.notes) L.push(`        – ${s.notes}`);
    });
  });
  return L.join('\n');
}

/** A tartalomjegyzék JSON-ként, K-címkékkel (a modellnek visszaadva). */
export function tocJson(p) {
  const labels = new Map(reqList(p).map(x => [x.req.id, x.label]));
  return JSON.stringify(
    {
      chapters: p.toc.chapters.map(ch => ({
        title: ch.title,
        summary: ch.summary,
        covers: ch.covers.map(id => labels.get(id)).filter(Boolean),
        sections: ch.sections.map(s => ({ title: s.title, notes: s.notes })),
      })),
    },
    null,
    2,
  );
}

export function uncoveredReqs(p) {
  const covered = new Set(p.toc.chapters.flatMap(c => c.covers));
  return reqList(p).filter(x => !covered.has(x.req.id));
}

const WRITER_SYSTEM = lang =>
  `Tapasztalt szakkönyvszerző és tananyagfejlesztő vagy. ${lang} nyelven írsz, pontosan, érthetően, a megadott célközönség és szint szerint. ` +
  `Szakmailag mindig pontos vagy: nem találsz ki nem létező parancsot, kapcsolót, beállítást vagy szabványt. ` +
  `Ha bizonytalan vagy egy részletben, inkább általánosabban fogalmazol.`;

const CRITIC_SYSTEM =
  'Szigorú, de igazságos szakmai lektor vagy. Szakmai pontosságot, teljességet, a célközönségnek megfelelő szintet, ' +
  'érthetőséget és a kért tartalmi elemek meglétét ellenőrzöd. Csak konkrét, ellenőrizhető észrevételeket teszel; ' +
  'nem dicsérsz feleslegesen, és nem kérsz olyat, ami nem tartozik az adott részhez. Válaszod mindig JSON.';

// ---------- Tartalomjegyzék ----------

const TOC_RULES = p => `Szabályok:
- Kb. ${p.brief.chapterCount} fejezet, fejezetenként 3–7 szakasz. A fejezetek logikusan, egymásra épülve következzenek (az alapoktól a bonyolultabb felé).
- Minden kötelező elemet (K-azonosító) legalább egy fejezet fedjen le; a fejezet "covers" mezőjében sorold fel a lefedett K-azonosítókat (pl. ["K1","K3"]). Ha nincs ilyen, üres lista.
- A "Hogyan" résznél kért formákat (pl. elmélet, beállítás lépésről lépésre, gyakorló feladat) külön szakaszként tervezd meg.
- A szakaszok "notes" mezőjében 2–4 mondatban konkrétan írd le, mi kerül bele: fogalmak, példák, parancsok, konfigurációk, feladatok.
- A fejezet "summary" mezője 1–2 mondat a fejezet céljáról.
- A címek legyenek rövidek, sorszám nélkül.
- Minden szöveg ${p.brief.language} nyelvű legyen.`;

export function tocGenerateMessages(p) {
  return [
    { role: 'system', content: WRITER_SYSTEM(p.brief.language) },
    {
      role: 'user',
      content: `Tervezd meg az alábbi könyv részletes tartalomjegyzékét.

${briefBlock(p)}

${TOC_RULES(p)}

Válaszolj kizárólag JSON-nal a megadott séma szerint.`,
    },
  ];
}

export function tocReviseMessages(p, { review, instruction }) {
  const fb = [];
  if (review) {
    fb.push('A LEKTOR ÉSZREVÉTELEI:');
    (review.critical || []).forEach(i => fb.push(`- KÖTELEZŐ JAVÍTÁS: ${i}`));
    review.issues.forEach(i => fb.push(`- ${i}`));
    review.suggestions.forEach(s => fb.push(`- Javaslat: ${s}`));
  }
  const unc = uncoveredReqs(p);
  if (unc.length) fb.push(`Egy fejezet sem fedi le ezeket a kötelező elemeket: ${unc.map(x => `${x.label} (${x.req.item})`).join(', ')}.`);
  if (instruction?.trim()) fb.push('', `A SZERZŐ UTASÍTÁSA (ez a legfontosabb, mindenképp teljesítsd): ${instruction.trim()}`);
  return [
    { role: 'system', content: WRITER_SYSTEM(p.brief.language) },
    {
      role: 'user',
      content: `Az alábbi könyv tartalomjegyzékét kell átdolgoznod.

${briefBlock(p)}

JELENLEGI TARTALOMJEGYZÉK (JSON):
${tocJson(p)}

${fb.join('\n')}

${TOC_RULES(p)}
- Ami jó, azt tartsd meg változatlanul (azonos címmel), csak a szükséges részeket módosítsd.

Add vissza a TELJES átdolgozott tartalomjegyzéket, kizárólag JSON-nal a megadott séma szerint.`,
    },
  ];
}

export function tocReviewMessages(p) {
  const unc = uncoveredReqs(p);
  return [
    { role: 'system', content: CRITIC_SYSTEM },
    {
      role: 'user',
      content: `Értékeld az alábbi könyv tartalomjegyzékét.

${briefBlock(p)}

TARTALOMJEGYZÉK:
${tocText(p, { notes: true })}
${unc.length ? `\nAutomatikus ellenőrzés: egy fejezet sem jelöli lefedettnek ezeket: ${unc.map(x => x.label).join(', ')}.` : ''}

Szempontok: minden kötelező elem a kért módon szerepel-e; logikus-e a sorrend és az egymásra épülés; megfelel-e a szint a célközönségnek; nincs-e átfedés vagy hiány; reális-e a terjedelem.

Pontszám (score) 1–10: 9–10 kiváló, 7–8 kisebb javítás kell, 5–6 komoly hiányok, 1–4 újratervezendő.
"summary": egy-két mondatos összegzés. "critical": kötelező elem hiánya vagy súlyos szerkezeti hiba (ha nincs, üres lista). "issues": egyéb konkrét problémák. "suggestions": konkrét javítási javaslatok.
Minden szöveg ${p.brief.language} nyelvű legyen. Válaszolj kizárólag JSON-nal.`,
    },
  ];
}

// ---------- Szakaszok ----------

/** A fejezet összes szakasza a tervével – hogy egyik modell se kérje számon / vegye előre a szomszédok témáját. */
export function chapterPlan(p, ci, si) {
  const ch = p.toc.chapters[ci];
  return ch.sections
    .map((s, i) => `${i === si ? '►' : ' '} ${ci + 1}.${i + 1} ${s.title}${i === si ? '  (EZ A SZAKASZ)' : ''}${s.notes ? `\n     terv: ${s.notes}` : ''}`)
    .join('\n');
}

function sectionContext(p, ci, si) {
  const ch = p.toc.chapters[ci];
  const sec = ch.sections[si];
  const labels = new Map(reqList(p).map(x => [x.req.id, x]));
  const L = [];

  L.push('A KÖNYV ADATAI', briefBlock(p), '');
  L.push('A KÖNYV TARTALOMJEGYZÉKE', tocText(p, { mark: sec.id }), '');

  const digests = p.toc.chapters
    .slice(0, ci)
    .map((c, i) => (c.digest ? `${i + 1}. ${c.title}:\n${c.digest}` : null))
    .filter(Boolean);
  if (digests.length) {
    L.push('A KORÁBBI FEJEZETEK TARTALMA (ezeket már elmagyaráztuk, ne ismételd részletesen, legfeljebb hivatkozz rájuk):');
    L.push(digests.join('\n\n'), '');
  }

  const prev = ch.sections.slice(0, si).filter(s => s.text);
  if (prev.length) {
    let budget = 14000;
    const parts = [];
    for (let i = prev.length - 1; i >= 0 && budget > 0; i--) {
      const t = prev[i].text.length > budget ? '…' + prev[i].text.slice(-budget) : prev[i].text;
      budget -= t.length;
      parts.unshift(`### ${prev[i].title}\n${t}`);
    }
    L.push('EBBEN A FEJEZETBEN MÁR MEGÍRT SZAKASZOK (folytasd zökkenőmentesen, ne ismételd őket):');
    L.push(parts.join('\n\n'), '');
  }

  L.push(`A MOST ÍRANDÓ RÉSZ: ${ci + 1}. fejezet „${ch.title}”, ${ci + 1}.${si + 1} szakasz „${sec.title}”`);
  if (ch.summary) L.push(`A fejezet célja: ${ch.summary}`);
  if (sec.notes) L.push(`A szakasz terve: ${sec.notes}`);
  const reqs = ch.covers.map(id => labels.get(id)).filter(Boolean);
  if (reqs.length) {
    L.push('A fejezethez tartozó kötelező elemek (a szakasz terve szerint az ide tartozó részt dolgozd ki):');
    for (const { label, req } of reqs) L.push(`[${label}] ${req.item}${req.how ? ` — Hogyan: ${req.how}` : ''}`);
  }
  L.push('', 'A FEJEZET SZAKASZAI ÉS TERVEIK (csak a ► jelű szakasz tervét dolgozd ki; ami egy másik szakasz terve, azt ott írjuk meg – ne vedd előre és ne ismételd, legfeljebb egy mondatban hivatkozz rá):');
  L.push(chapterPlan(p, ci, si));
  return L.join('\n');
}

const SECTION_RULES = p => `Formai szabályok:
- Markdown formátum. A szakasz címét NE írd ki (azt a program teszi hozzá). Alcímekhez "####" (alatta "#####") szintet használj.
- Kizárólag ${p.brief.language} nyelven írj; más írásrendszerű karakter (pl. kínai, japán, cirill) vagy idegen nyelvű szó nem kerülhet a szövegbe (a szakkifejezések, parancsok kivételek).
- A parancsok, konfigurációs direktívák és kapcsolók pontosan a valós szoftver szintaxisát kövessék.
- Parancsot, konfigurációt, kódot mindig \`\`\` blokkba tegyél nyelvjelöléssel (pl. \`\`\`bash, \`\`\`ini, \`\`\`powershell).
- Gyakorló feladatnál adj egyértelmű feladatleírást, kiinduló adatokat${p.brief.extras?.solutions ? ', és a végén a megoldást „Megoldás” alcímmel' : ''}.
- Terjedelem: kb. ${p.brief.wordsPerSection} szó (a feladat jellegétől függően ettől kissé eltérhet).
- Csak magát a szakasz szövegét add vissza, bevezető vagy záró megjegyzés („Íme a szakasz…”) nélkül.`;

export function sectionWriteMessages(p, ci, si) {
  return [
    { role: 'system', content: WRITER_SYSTEM(p.brief.language) },
    {
      role: 'user',
      content: `${sectionContext(p, ci, si)}

${SECTION_RULES(p)}

Írd meg most ezt a szakaszt.`,
    },
  ];
}

export function sectionReviseMessages(p, ci, si, text, { review, instruction }) {
  const fb = [];
  if (review) {
    fb.push(`A LEKTOR ÉRTÉKELÉSE: ${review.score}/10 – ${review.summary}`);
    (review.critical || []).forEach(i => fb.push(`- KÖTELEZŐ JAVÍTÁS: ${i}`));
    review.issues.forEach(i => fb.push(`- Probléma: ${i}`));
    review.suggestions.forEach(s => fb.push(`- Javaslat: ${s}`));
  }
  if (instruction?.trim()) fb.push('', `A SZERZŐ UTASÍTÁSA (ez a legfontosabb, mindenképp teljesítsd): ${instruction.trim()}`);
  return [
    { role: 'system', content: WRITER_SYSTEM(p.brief.language) },
    {
      role: 'user',
      content: `${sectionContext(p, ci, si)}

A SZAKASZ JELENLEGI VÁLTOZATA:
<<<
${text}
>>>

${fb.join('\n')}

Dolgozd át a szakaszt: javítsd a jogos észrevételeket (ha egy lektori megjegyzés szakmailag téves, azt hagyd figyelmen kívül), a jó részeket tartsd meg.

${SECTION_RULES(p)}

Add vissza a TELJES átdolgozott szakaszt.`,
    },
  ];
}

export function sectionReviewMessages(p, ci, si, text) {
  const ch = p.toc.chapters[ci];
  const sec = ch.sections[si];
  const labels = new Map(reqList(p).map(x => [x.req.id, x]));
  const reqs = ch.covers.map(id => labels.get(id)).filter(Boolean);
  return [
    { role: 'system', content: CRITIC_SYSTEM },
    {
      role: 'user',
      content: `Lektoráld egy szakkönyv alábbi szakaszát.

Célközönség: ${p.brief.audience || '-'}
Szint: ${p.brief.level}
Nyelv: ${p.brief.language}
Fejezet: ${ci + 1}. ${ch.title}
Szakasz: ${ci + 1}.${si + 1} ${sec.title}
A szakasz terve: ${sec.notes || '-'}

A fejezet szakaszai és terveik (FONTOS: csak azt kérd számon, ami a ► jelű szakasz tervébe tartozik; ami egy másik szakasz terve, az itt NEM hiány – ha ez a szakasz mégis részletesen kifejti, azt jelezd ismétlésként):
${chapterPlan(p, ci, si)}

${reqs.length ? `A fejezethez tartozó kötelező elemek (ezekből csak a ► szakasz tervébe eső részt kérd számon):\n${reqs.map(({ label, req }) => `[${label}] ${req.item}${req.how ? ` — Hogyan: ${req.how}` : ''}`).join('\n')}` : ''}
Kért terjedelem: kb. ${p.brief.wordsPerSection} szó (a tényleges: kb. ${wordCount(text)} szó).

A SZAKASZ SZÖVEGE:
<<<
${text}
>>>

Ellenőrizd: szakmai hibák – a kódblokkokat soronként nézd át: valóban létező parancs, kapcsoló, konfigurációs direktíva-e (pl. helyes kulcsszó, szintaxis, fájlútvonal); a terv és a kötelező elemek teljesülése; a szint megfelelő-e a célközönségnek; érthetőség, logikus felépítés; nyelvhelyesség; ha van gyakorló feladat, egyértelmű és megoldható-e.

Pontszám (score) 1–10: 9–10 kiadható, 7–8 kisebb javítás kell, 5–6 komoly hiányok, 1–4 újraírandó.
"summary": egy-két mondatos összegzés.
"critical": a feltétlenül javítandó hibák – szakmailag hibás parancs/direktíva/beállítás, hibás állítás, idegen írásrendszerű karakter vagy más nyelvű szó a szövegben, csonka szöveg. Ha nincs ilyen, üres lista. Ami nem ilyen súlyú, az az "issues"-ba kerüljön.
"issues": egyéb konkrét problémák (hol, mi a hiba). "suggestions": konkrét javítási javaslatok.
Minden szöveg ${p.brief.language} nyelvű legyen. Válaszolj kizárólag JSON-nal.`,
    },
  ];
}

export function chapterDigestMessages(p, ci) {
  const ch = p.toc.chapters[ci];
  let text = ch.sections.map(s => `### ${s.title}\n${s.text || ''}`).join('\n\n');
  if (text.length > 40000) text = text.slice(0, 40000) + '\n…';
  return [
    {
      role: 'system',
      content: 'Tömören és pontosan foglalsz össze szakmai szövegeket. Csak az összefoglalót adod vissza.',
    },
    {
      role: 'user',
      content: `Foglald össze az alábbi fejezetet 5–10 rövid pontban (${p.brief.language} nyelven): milyen fogalmakat vezettünk be, milyen eszközöket, parancsokat, beállításokat mutattunk be, milyen példák és feladatok szerepeltek. Az összefoglalót a későbbi fejezetek írója kapja meg, hogy ne ismételjen és tudjon hivatkozni.

FEJEZET: ${ci + 1}. ${ch.title}

${text}`,
    },
  ];
}

export function wordCount(t) {
  return (String(t || '').match(/[\p{L}\p{N}]+/gu) || []).length;
}
