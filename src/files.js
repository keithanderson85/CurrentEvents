import path from 'node:path';

// Turn an uploaded file into plain text for the assistant.
// Supported: PDF, Word (.docx), and text-like files (txt, md, json, csv, html, xml, log).

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.yaml', '.yml', '.rtf']);

export async function extractFile(name, buf) {
  const ext = path.extname(name || '').toLowerCase();
  const isPdf = ext === '.pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // .docx is a zip
  let text = '';
  let pages;
  if (isPdf) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const r = await extractText(pdf, { mergePages: true });
    text = Array.isArray(r.text) ? r.text.join('\n\n') : r.text;
    pages = r.totalPages;
    if (!text.trim()) throw new Error('This PDF has no readable text (it may be scanned images).');
  } else if (ext === '.docx' || (isZip && ext !== '.json')) {
    const mammoth = (await import('mammoth')).default;
    text = (await mammoth.extractRawText({ buffer: buf })).value;
  } else if (ext === '.doc') {
    throw new Error('Old-style .doc files can’t be read. Save it as .docx or PDF and try again.');
  } else if (TEXT_EXT.has(ext) || !buf.subarray(0, 4000).includes(0)) {
    text = buf.toString('utf8');
    if (ext === '.json') {
      try {
        text = JSON.stringify(JSON.parse(text), null, 1); // compact but readable
      } catch {} // not valid JSON: keep as-is
    }
    if (ext === '.html' || ext === '.htm') text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
    if (ext === '.rtf') text = text.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/g, '');
  } else {
    throw new Error('That file type isn’t supported. Use PDF, Word (.docx), text, Markdown, CSV or JSON.');
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('No readable text found in that file.');
  return { text, pages };
}
