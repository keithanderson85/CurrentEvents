import { config } from './config.js';
import { setting } from './store.js';

// Thin OpenRouter client (OpenAI-compatible chat completions API).

export function currentModel(kind = 'main') {
  const main = setting('model', config.openrouter.model);
  if (kind === 'research') return setting('researchModel', config.openrouter.researchModel) || main;
  return main;
}

function headers() {
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY is not set. Add it to your .env file.');
  return {
    Authorization: `Bearer ${config.openrouter.apiKey}`,
    'Content-Type': 'application/json',
    // Optional attribution headers OpenRouter shows on its dashboard.
    'HTTP-Referer': 'http://localhost',
    'X-Title': 'OpenFrame News',
  };
}

// Reasoning ("thinking") models can spend the whole token budget thinking and return an empty
// answer. For this app's short structured tasks thinking isn't needed, so it's off by default.
// OPENROUTER_REASONING: off | low | medium | high
function reasoningParam() {
  const r = (config.openrouter.reasoning || 'off').toLowerCase();
  if (r === 'default' || r === '') return undefined;
  if (r === 'off' || r === 'none' || r === 'false') return { enabled: false };
  return { effort: r };
}

async function complete(messages, { model, temperature = 0.3, maxTokens = 4000, json = false, signal, reasoning = reasoningParam() } = {}) {
  const body = { model: model || currentModel(), messages, temperature, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  if (reasoning) body.reasoning = reasoning;
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Some models reject response_format or the reasoning switch; retry once without them.
    if (res.status === 400 && reasoning && /reason|think/i.test(text)) {
      return complete(messages, { model, temperature, maxTokens, json, signal, reasoning: null });
    }
    if (res.status === 400 && json && /response_format|json/i.test(text)) {
      return complete(messages, { model, temperature, maxTokens, json: false, signal, reasoning });
    }
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`);
  const choice = data.choices?.[0] || {};
  return {
    content: choice.message?.content ?? '',
    finish: choice.finish_reason || choice.native_finish_reason || '',
    reasoningChars: (choice.message?.reasoning || '').length,
  };
}

export async function chat(messages, opts = {}) {
  const r = await complete(messages, opts);
  if (!r.content.trim()) {
    // Retry once with more room (the usual cause is a model "thinking" until it hits the limit).
    const r2 = await complete(messages, { ...opts, maxTokens: Math.round((opts.maxTokens || 4000) * 2) });
    if (!r2.content.trim()) throw new Error(emptyMsg(r2));
    return r2.content;
  }
  return r.content;
}

const emptyMsg = (r) =>
  `Empty model response (finish: ${r.finish || 'unknown'}${r.reasoningChars ? `, ${r.reasoningChars} chars of hidden reasoning` : ''}). Try another model in Settings, or set OPENROUTER_REASONING=off.`;

// Ask for JSON and parse it robustly (models sometimes wrap JSON in prose or code fences, or get cut off).
export async function chatJSON(messages, opts = {}) {
  const maxTokens = opts.maxTokens || 4000;
  let first;
  try {
    first = await complete(messages, { ...opts, json: true, maxTokens });
    if (first.content.trim()) return parseJSONLoose(first.content);
  } catch (e) {
    if (/^OpenRouter (4|5)\d\d/.test(e.message) && !/400/.test(e.message)) throw e;
  }
  // Second try: no JSON mode, more tokens, and an explicit reminder.
  const retry = await complete(
    [...messages, { role: 'system', content: 'Reply with only the JSON object, no prose and no code fences. Keep it compact.' }],
    { ...opts, json: false, maxTokens: Math.round(maxTokens * 1.75) }
  );
  if (!retry.content.trim()) throw new Error(emptyMsg(retry));
  try {
    return parseJSONLoose(retry.content);
  } catch (e) {
    throw new Error(`${e.message}${retry.finish === 'length' ? ' (answer was cut off: too long)' : ''}`);
  }
}

export function parseJSONLoose(raw) {
  if (!raw) throw new Error('Empty model response');
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(s);
  } catch {
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error('Model did not return valid JSON: ' + s.slice(0, 200));
  }
}

// Streams tokens; calls onToken(text) for each delta. Resolves with the full text.
export async function chatStream(messages, { model, temperature = 0.4, maxTokens = 2000, onToken, signal } = {}) {
  const send = (reasoning) =>
    fetch(`${config.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: model || currentModel(), messages, temperature, max_tokens: maxTokens, stream: true, ...(reasoning ? { reasoning } : {}) }),
      signal,
    });
  let res = await send(reasoningParam());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400 && reasoningParam() && /reason|think/i.test(text)) res = await send(null);
    else throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue; // skips ": OPENROUTER PROCESSING" keep-alives
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const j = JSON.parse(payload);
        if (j.error) throw new Error(j.error.message || 'stream error');
        const t = j.choices?.[0]?.delta?.content;
        if (t) {
          full += t;
          onToken?.(t);
        }
      } catch (e) {
        if (e.message && !/JSON/.test(e.message)) throw e;
      }
    }
  }
  return full;
}

// Checks the configured model exists on OpenRouter; returns suggestions if not.
export async function checkModel() {
  const model = currentModel();
  try {
    const res = await fetch(`${config.openrouter.baseUrl}/models`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: null, model };
    const { data } = await res.json();
    const ids = data.map((m) => m.id);
    if (ids.includes(model)) return { ok: true, model };
    const suggestions = ids.filter((id) => id.includes('deepseek')).slice(0, 15);
    return { ok: false, model, suggestions };
  } catch {
    return { ok: null, model };
  }
}
