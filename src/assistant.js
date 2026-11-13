import { db, save } from './store.js';
import { chatStream, chatJSON, currentModel } from './llm.js';
import { truncate, fetchArticle, mapLimit } from './fetcher.js';
import { webSearch } from './chat.js';
import { createManualEvent, addArticleToEvent } from './manual.js';
import { runDeepDive } from './research.js';
import { domainOf } from './sources.js';

// The Assistant: a general chat that can also do things in the app. Anything that changes
// your data (new event, adding links, starting a deep dive) is only *proposed*: you get a
// card and nothing happens until you confirm.

const thread = () => {
  const store = db();
  store.assistant = store.assistant || { messages: [] };
  return store.assistant;
};
export const assistantMessages = () => thread().messages;
export function clearAssistant() {
  thread().messages = [];
  save();
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const ACTIONS = ['none', 'search', 'create_event', 'add_to_event', 'deep_dive'];

const recentEvents = () =>
  Object.values(db().events)
    .filter((e) => e.articleIds.length || e.manual)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 40);

async function plan(history, message, urls) {
  const events = recentEvents();
  try {
    const r = await chatJSON(
      [
        {
          role: 'system',
          content: `You route requests for the assistant inside a personal news app. The app groups news into "events" the user can open, add links to, chat about and run a "deep dive" (cited research briefing) on.
Return JSON {"action":"none|search|create_event|add_to_event|deep_dive","queries":[0-2 short keyword web search queries, 3-7 words],"research":true|false,"title":"","description":"","event_id":"","focus":""}.
- create_event: the user wants to follow, track, find out about or dig into a specific news story or topic that is not already in EXISTING EVENTS. Give a short, neutral title (max 10 words) and a one-sentence description of what to look for. Also give queries so the assistant can say what it found so far.
- add_to_event: the user dropped links or facts and wants them added to one of the EXISTING EVENTS (set event_id), or the links clearly belong to one.
- deep_dive: the user wants in-depth research or fact-checking on one of the EXISTING EVENTS (set event_id; focus = optional angle).
- search: a question that needs current or factual information from the web (news, facts, figures, people, prices, how-tos that may have changed). Give queries. Set research true if studies or official data would help.
- none: casual chat, opinions, writing help, maths, or anything answerable without looking things up, and questions about links the user just dropped.
If the topic matches an existing event, prefer deep_dive or search over create_event. event_id must be copied exactly from the list.`,
        },
        {
          role: 'user',
          content: `EXISTING EVENTS:\n${events.map((e) => `${e.id}: ${e.title}`).join('\n') || '(none)'}\n${
            history.length ? `\nRECENT CHAT:\n${history.slice(-6).map((m) => `${m.role}: ${truncate(m.content, 300)}`).join('\n')}\n` : ''
          }${urls.length ? `\nLINKS IN THE MESSAGE: ${urls.join(' ')}\n` : ''}\nMESSAGE: ${truncate(message, 1500)}`,
        },
      ],
      { temperature: 0, maxTokens: 350 }
    );
    const action = ACTIONS.includes(r.action) ? r.action : 'none';
    return {
      action,
      queries: (r.queries || []).map(String).filter(Boolean).slice(0, 2),
      research: Boolean(r.research),
      title: String(r.title || '').trim(),
      description: String(r.description || '').trim(),
      eventId: String(r.event_id || '').trim(),
      focus: String(r.focus || '').trim(),
    };
  } catch {
    return { action: 'none', queries: [] };
  }
}

function proposalFrom(p, urls) {
  const ev = p.eventId ? db().events[p.eventId] : null;
  if (p.action === 'create_event' && p.title) return { type: 'create_event', title: truncate(p.title, 120), description: p.description, urls, status: 'pending' };
  if (p.action === 'add_to_event' && ev && urls.length) return { type: 'add_to_event', eventId: ev.id, eventTitle: ev.title, urls, status: 'pending' };
  if (p.action === 'deep_dive' && ev) return { type: 'deep_dive', eventId: ev.id, eventTitle: ev.title, focus: p.focus, status: 'pending' };
  return null;
}

const describe = (pr) =>
  pr.type === 'create_event'
    ? `create a new event titled "${pr.title}"${pr.urls.length ? ` starting from the ${pr.urls.length} link(s) they sent` : ''} and gather coverage for it`
    : pr.type === 'add_to_event'
    ? `add ${pr.urls.length} link(s) to the existing event "${pr.eventTitle}"`
    : `run a deep dive on the existing event "${pr.eventTitle}"${pr.focus ? ` focused on ${pr.focus}` : ''}`;

const SYSTEM = () => `You are the assistant inside OpenFrame News, a personal news dashboard. Today is ${new Date().toDateString()}. You can talk about anything: news, general questions, writing, ideas.
- Be direct, friendly and concise. Use Markdown (short paragraphs, bullets) when it helps.
- For current events and changeable facts, rely on WEB SEARCH RESULTS and DROPPED LINKS when given. Cite a web result as a Markdown link with its number, like [W1](url), using the exact URL. If you answer from general knowledge instead, say so and note it may be out of date.
- Separate what is established from what is claimed or disputed. Never invent facts, numbers or quotes.
- You cannot change anything in the app yourself. When a PROPOSED ACTION is listed, the user sees a card with Confirm and Cancel buttons below your reply. Say in one sentence what the action would do and ask them to confirm. Never say it has been done.
- If no action is proposed and the user wants one, tell them what you can do: follow a story as a new event, add links to an event, or run a deep dive on an event.`;

export async function streamAssistant(message, { onToken, onStatus = () => {}, onSources = () => {}, onProposal = () => {}, signal }) {
  const t = thread();
  const history = t.messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  t.messages.push({ role: 'user', content: message, ts: new Date().toISOString() });
  save();

  const urls = [...new Set(message.match(URL_RE) || [])].slice(0, 8);
  const p = await plan(history, message, urls);
  const proposal = proposalFrom(p, urls);

  // Read links the user dropped in, so they can be discussed straight away.
  let dropped = [];
  if (urls.length) {
    onStatus(`Reading ${urls.length} link${urls.length === 1 ? '' : 's'}…`);
    const pages = await mapLimit(urls.slice(0, 4), 4, (u) => fetchArticle(u, { timeout: 10000 }));
    dropped = urls.slice(0, 4).map((u, i) => ({ url: u, title: pages[i]?.title || domainOf(u), text: pages[i]?.text ? truncate(pages[i].text, 2500) : '' }));
  }
  let sources = [];
  if (p.queries.length && p.action !== 'none' && p.action !== 'add_to_event' && !signal?.aborted) {
    onStatus(`Searching the web: ${p.queries.join(' · ')}`);
    sources = await webSearch({ queries: p.queries, research: p.research }).catch(() => []);
    if (sources.length) onSources(sources.map(({ text, ...s }) => s));
  }
  if (proposal) onProposal(proposal);

  const blocks = [];
  if (dropped.length)
    blocks.push(`DROPPED LINKS (sent by the user in this message):\n${dropped.map((d) => `${d.title}\nURL: ${d.url}\n${d.text || '(could not read this page)'}`).join('\n\n')}`);
  if (sources.length)
    blocks.push(
      `WEB SEARCH RESULTS (fetched now):\n${sources
        .map((s) => `[W${s.n}] ${s.kind.toUpperCase()} — ${s.name}${s.meta ? ` (${s.meta})` : ''} — ${s.title}${s.headlineOnly ? ' (headline only)' : ''}\nURL: ${s.url}\n${s.headlineOnly ? '' : s.text}`)
        .join('\n\n')}`
    );
  if (proposal) blocks.push(`PROPOSED ACTION (awaiting the user's confirmation): ${describe(proposal)}.`);
  const events = recentEvents().slice(0, 25);
  if (events.length) blocks.push(`EVENTS CURRENTLY IN THE APP (for reference):\n${events.map((e) => `- ${e.title}${e.check?.verdict ? ` [${e.check.verdict}]` : ''}`).join('\n')}`);

  const messages = [{ role: 'system', content: SYSTEM() }, ...history, ...(blocks.length ? [{ role: 'system', content: blocks.join('\n\n') }] : []), { role: 'user', content: message }];
  let full = '';
  try {
    full = await chatStream(messages, { model: currentModel('research'), onToken, signal, maxTokens: 2200 });
  } finally {
    if (full || proposal) {
      t.messages.push({
        role: 'assistant',
        content: full,
        ts: new Date().toISOString(),
        ...(sources.length ? { sources: sources.map(({ text, ...s }) => s) } : {}),
        ...(proposal ? { proposal } : {}),
      });
      save();
    }
  }
  return full;
}

// Carry out (or decline) the proposal attached to a message. Only ever called from the user's click.
export async function actOnProposal(index, accept) {
  const t = thread();
  const msg = t.messages[index];
  const pr = msg?.proposal;
  if (!pr) throw new Error('That suggestion is no longer available.');
  if (pr.status !== 'pending') return { proposal: pr };
  if (!accept) {
    pr.status = 'declined';
    save();
    return { proposal: pr };
  }
  let note = '';
  if (pr.type === 'create_event') {
    const ev = await createManualEvent({ title: pr.title, description: pr.description || '', urls: pr.urls || [], autoFind: true });
    pr.eventId = ev.id;
    note = `Done. I created **${ev.title}** and I'm gathering coverage for it now. It will keep tracking new articles.`;
  } else {
    const ev = db().events[pr.eventId];
    if (!ev) throw new Error('That event no longer exists.');
    if (pr.type === 'add_to_event') {
      const results = await mapLimit(pr.urls, 3, (u) => addArticleToEvent(ev, u));
      const ok = results.filter((r) => r && !r.error).length;
      note = `Done. I added ${ok} of ${pr.urls.length} link${pr.urls.length === 1 ? '' : 's'} to **${ev.title}**.`;
    } else {
      await runDeepDive(ev.id, { focus: pr.focus || '' });
      note = `Done. The deep dive on **${ev.title}** is running. It takes a minute or two; open the event to watch it.`;
    }
  }
  pr.status = 'done';
  const reply = { role: 'assistant', content: note, ts: new Date().toISOString(), eventId: pr.eventId };
  t.messages.push(reply);
  save();
  return { proposal: pr, message: reply };
}
