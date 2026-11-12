import { db, save } from './store.js';
import { chatStream, currentModel } from './llm.js';
import { truncate } from './fetcher.js';

// Builds the context the model sees when you chat with an event: its articles,
// your notes/custom data, and the latest deep-dive briefing.
export function eventContext(event) {
  const store = db();
  const articles = event.articleIds.map((id) => store.articles[id]).filter(Boolean);
  const arts = articles
    .slice(0, 25)
    .map((a, i) => `(${i + 1}) ${a.source} [${a.lean || 'unknown lean'}] — ${a.title}\n${truncate(a.text || a.summary || '', a.text ? 1500 : 400)}\n${a.url}`)
    .join('\n\n');
  const notes = (event.notes || [])
    .map((n) => {
      const head = n.label ? `${n.label}: ` : '';
      const body = n.text || '';
      const link = n.url ? `\n  (link: ${n.url}${n.linkTitle ? ' — ' + n.linkTitle : ''})${n.linkText ? '\n  ' + truncate(n.linkText, 1500) : ''}` : '';
      return `- ${head}${body}${link}`;
    })
    .join('\n');
  const latest = (event.research || []).find((r) => r.status === 'done' && r.briefing);
  const research = latest
    ? `${latest.briefing}\n\nBriefing sources:\n${latest.sources.map((s) => `[${s.n}] ${s.name} — ${s.title} (${s.url})`).join('\n')}`
    : '';
  return `EVENT: ${event.title}
CATEGORY: ${event.category || 'Other'}
SUMMARY: ${event.summary || '(none)'}

ARTICLES IN THIS EVENT:
${arts || '(none)'}
${notes ? `\nTHE USER'S OWN NOTES / CUSTOM DATA ON THIS EVENT:\n${notes}\n` : ''}${research ? `\nLATEST DEEP-DIVE BRIEFING:\n${research}\n` : ''}`;
}

const SYSTEM = `You are a sharp, even-handed news research assistant. The user is looking at one news event in their personal news dashboard and wants to discuss it.
- Ground answers in the provided articles, the user's notes and the briefing. Cite articles as (1), (2) etc. and briefing sources as [n].
- Clearly separate what is reported/verified from what is claimed, disputed or your own general knowledge. If you add general background knowledge, say so, and note it may be out of date.
- Be balanced: when outlets disagree, present the different accounts and who reports them.
- Be concise and use Markdown (short paragraphs, bullets). If the provided material can't answer something, say so and suggest running a Deep dive with a specific focus.`;

export async function streamChat(eventId, message, { onToken, signal }) {
  const event = db().events[eventId];
  if (!event) throw new Error('Event not found');
  event.chat = event.chat || [];
  const history = event.chat.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: eventContext(event) },
    ...history,
    { role: 'user', content: message },
  ];
  event.chat.push({ role: 'user', content: message, ts: new Date().toISOString() });
  save();
  let full = '';
  try {
    full = await chatStream(messages, { model: currentModel('research'), onToken, signal });
  } finally {
    if (full) {
      event.chat.push({ role: 'assistant', content: full, ts: new Date().toISOString() });
      save();
    }
  }
  return full;
}
