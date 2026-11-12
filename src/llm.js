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
    'X-Title': 'Current Events',
  };
}

export async function chat(messages, { model, temperature = 0.3, maxTokens = 4000, json = false, signal } = {}) {
  const body = {
    model: model || currentModel(),
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Some models reject response_format; retry once without it.
    if (json && res.status === 400 && /response_format|json/i.test(text)) {
      return chat(messages, { model, temperature, maxTokens, json: false, signal });
    }
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`);
  return data.choices?.[0]?.message?.content ?? '';
}

// Ask for JSON and parse it robustly (models sometimes wrap JSON in prose or code fences).
export async function chatJSON(messages, opts = {}) {
  const raw = await chat(messages, { ...opts, json: true });
  return parseJSONLoose(raw);
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
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: model || currentModel(), messages, temperature, max_tokens: maxTokens, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`);
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
