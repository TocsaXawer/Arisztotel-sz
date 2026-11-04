// A kész könyv exportálása Markdown és nyomtatható HTML formában.
import { renderMarkdown } from '../public/md.js';

export function exportMarkdown(p) {
  const title = p.brief.title || 'Névtelen könyv';
  const L = [`# ${title}`, ''];
  L.push('## Tartalomjegyzék', '');
  p.toc.chapters.forEach((ch, ci) => {
    L.push(`${ci + 1}. ${ch.title}`);
    ch.sections.forEach((s, si) => L.push(`    - ${ci + 1}.${si + 1} ${s.title}`));
  });
  L.push('');
  p.toc.chapters.forEach((ch, ci) => {
    L.push('', `## ${ci + 1}. ${ch.title}`, '');
    ch.sections.forEach((s, si) => {
      L.push(`### ${ci + 1}.${si + 1} ${s.title}`, '');
      L.push(s.text?.trim() || '*(Ez a szakasz még nincs megírva.)*', '');
    });
  });
  return L.join('\n');
}

export function exportHtml(p) {
  const title = p.brief.title || 'Névtelen könyv';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 16px/1.65 Georgia, 'Times New Roman', serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #1d1d1f; background: #fff; }
  h1 { font-size: 2.2em; text-align: center; margin: 1.5em 0 1em; }
  h2 { font-size: 1.6em; margin-top: 2.5em; border-bottom: 1px solid #ddd; padding-bottom: .2em; page-break-before: always; }
  h2:first-of-type { page-break-before: auto; }
  h3 { font-size: 1.25em; margin-top: 1.8em; }
  h4 { font-size: 1.05em; margin-top: 1.4em; }
  pre { background: #f5f5f7; border: 1px solid #e3e3e8; border-radius: 6px; padding: 12px 14px; overflow-x: auto; font-size: 13.5px; line-height: 1.45; page-break-inside: avoid; }
  code { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: .9em; }
  :not(pre) > code { background: #f2f2f5; padding: 1px 4px; border-radius: 4px; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #f5f5f7; }
  blockquote { border-left: 3px solid #ccc; margin: 1em 0; padding: .2em 1em; color: #555; }
  @media print { body { margin: 0; max-width: none; } a { color: inherit; } }
</style></head>
<body>
${renderMarkdown(exportMarkdown(p))}
</body></html>`;
}
