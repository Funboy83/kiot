// Tiny Markdown renderer for assistant answers. Builds Preact nodes directly (never innerHTML),
// so model output cannot inject markup. Supports headings, paragraphs, bullet and numbered
// lists, pipe tables, fenced blocks, **bold**, *italic* and `code`.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code>{t.slice(1, -1)}</code>);
    else out.push(<em>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Splits text into blocks: { type: 'fence', lang, body, open } | { type: 'md', lines }.
 * `open` marks a fence still being streamed.
 */
export function splitBlocks(text) {
  const blocks = [];
  let md = [];
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence) {
      if (/^\s*```\s*$/.test(line)) {
        blocks.push({ type: 'fence', lang: fence.lang, body: fence.body.join('\n'), open: false });
        fence = null;
      } else fence.body.push(line);
      continue;
    }
    const m = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (m) {
      if (md.length) blocks.push({ type: 'md', lines: md });
      md = [];
      fence = { lang: m[1].toLowerCase(), body: [] };
    } else md.push(line);
  }
  if (fence) blocks.push({ type: 'fence', lang: fence.lang, body: fence.body.join('\n'), open: true });
  if (md.length) blocks.push({ type: 'md', lines: md });
  return blocks;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function Markdown({ lines }) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const Tag = h[1].length <= 2 ? 'h3' : 'h4';
      out.push(<Tag>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        <div class="table-wrap md-table">
          <table class="table">
            <thead><tr>{head.map((c) => <th>{inline(c)}</th>)}</tr></thead>
            <tbody>{body.map((r) => <tr>{r.map((c) => <td>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    const li = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[2]) === ordered && m[1].length < 2) items.push([m[3]]);
        else if (m && m[1].length >= 2 && items.length) items[items.length - 1].push('• ' + m[3]);
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].push(lines[i].trim());
        else break;
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(<List>{items.map((parts) => <li>{parts.map((p, k) => (k ? [<br />, inline(p)] : inline(p)))}</li>)}</List>);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^(\s*)([-*•]|\d+[.)])\s|^\s*\|/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p>{para.map((p, k) => (k ? [<br />, inline(p)] : inline(p)))}</p>);
  }
  return <>{out}</>;
}
