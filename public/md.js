// Kicsi, függőség nélküli Markdown → HTML átalakító (a böngésző és a szerver is használja).

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
  return s;
}

const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function dedent(lines) {
  const ind = Math.min(...lines.filter(l => l.trim()).map(indentOf));
  return lines.map(l => l.replace(/\t/g, '    ').slice(Number.isFinite(ind) ? ind : 0));
}

const isBlockStart = (l, next) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || (TABLE_ROW.test(l) && next !== undefined && TABLE_SEP.test(next));

const cells = row =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (!line.trim()) {
      i++;
    } else if ((m = line.match(FENCE))) {
      const close = m[1];
      const lang = m[2];
      const buf = [];
      const ind = indentOf(line);
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${close}\\s*$`).test(lines[i])) {
        buf.push(lines[i].replace(new RegExp(`^ {0,${ind}}`), ''));
        i++;
      }
      i++;
      html += `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>\n`;
    } else if ((m = line.match(HEADING))) {
      const n = m[1].length;
      html += `<h${n}>${inline(m[2])}</h${n}>\n`;
      i++;
    } else if (HR.test(line)) {
      html += '<hr>\n';
      i++;
    } else if (QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>\n`;
    } else if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] || '')) {
      const head = cells(line);
      i += 2;
      let t = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        t += '<tr>' + cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += t + '</tbody></table>\n';
    } else if ((m = line.match(LIST))) {
      const base = indentOf(line);
      const ordered = /\d/.test(m[2]);
      const startNum = ordered ? parseInt(m[2], 10) : 1;
      const sameType = mm => mm && /\d/.test(mm[2]) === ordered;
      const items = [];
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(LIST);
        if (sameType(lm) && indentOf(l) === base) {
          cur = [lm[3]];
          items.push(cur);
          i++;
        } else if (!l.trim()) {
          const nx = lines[i + 1];
          if (nx !== undefined && nx.trim() && (indentOf(nx) > base || (sameType(nx.match(LIST)) && indentOf(nx) === base))) {
            cur.push('');
            i++;
          } else break;
        } else if (indentOf(l) > base) {
          cur.push(l);
          i++;
        } else if (!lm && !isBlockStart(l, lines[i + 1])) {
          cur.push(l); // lusta folytatás
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ''}>`;
      for (const it of items) {
        const rest = it.slice(1);
        const lazy = [];
        while (rest.length && rest[0].trim() && indentOf(rest[0]) <= base) lazy.push(rest.shift().trim());
        const restMd = rest.some(l => l.trim()) ? renderMarkdown(dedent(rest).join('\n')) : '';
        html += `<li>${inline([it[0], ...lazy].join(' '))}${restMd}</li>`;
      }
      html += `</${tag}>\n`;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i], lines[i + 1]))) buf.push(lines[i++].trim());
      html += `<p>${inline(buf.join('\n')).replace(/\n/g, ' ')}</p>\n`;
    }
  }
  return html;
}
