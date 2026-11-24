// Minimal, dependency-free Markdown renderer for the assistant's output.
// All input is HTML-escaped before any transform, so model text cannot inject
// markup. Supports the subset the tutor emits: headings, paragraphs, bold,
// inline code, lists, tables, blockquotes and rules.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ESC[c]);
}

function inline(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, (_m, p) => `<code>${p}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return s.replace(/https:\/\/cet\.neea\.edu\.cn\/x?html1\/folder\/\d+\/\d+-\d+\.htm\b/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">中国教育考试网</a>`);
}

function splitRow(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split('|').map(c => c.trim());
}

function isSeparator(row) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(row) && row.includes('-');
}

function renderTable(rows) {
  if (!rows.length) return '';
  const header = splitRow(rows[0]);
  const bodyStart = rows[1] && isSeparator(rows[1]) ? 2 : 1;
  const isVocab = header.some(h => /单词/.test(h)) && header.some(h => /音标/.test(h));
  const thead = '<thead><tr>' + header.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead>';
  const body = rows.slice(bodyStart).map(r => {
    const cells = splitRow(r);
    return '<tr>' + cells.map((c, idx) => {
      let content = inline(c);
      if (isVocab) {
        const plain = c.trim();
        if (plain === '四级') content = '<span class="badge badge-cet4">四级</span>';
        else if (plain === '六级') content = '<span class="badge badge-cet6">六级</span>';
        if (idx === 0) content = `<span class="vocab-word">${content}</span>`;
        if (idx === 1) content = `<span class="vocab-phonetic">${content}</span>`;
      }
      return `<td>${content}</td>`;
    }).join('') + '</tr>';
  }).join('');
  return `<div class="table-wrap"><table class="${isVocab ? 'vocab-table' : ''}">${thead}<tbody>${body}</tbody></table></div>`;
}

export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = l => /^\s*\|/.test(l) || /^#{1,6}\s/.test(l) || /^\s*[-*+]\s+/.test(l)
    || /^\s*\d+\.\s+/.test(l) || /^\s*>\s?/.test(l) || /^\s*([-*_])\s*(\1\s*){2,}$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i].trim()); i++; }
      out.push(renderTable(rows));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++; continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      out.push('<ul>' + items.map(it => {
        const cls = /✅|正确/.test(it) ? ' class="opt opt-correct"'
          : /❌|错误/.test(it) ? ' class="opt opt-wrong"' : '';
        return `<li${cls}>${inline(it)}</li>`;
      }).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push('<ol>' + items.map(it => `<li>${inline(it)}</li>`).join('') + '</ol>');
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}