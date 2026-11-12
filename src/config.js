import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  root,
  port: num(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  openrouter: {
    // Never hard-code the key. It comes from the environment (or a local .env that git ignores).
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
    // Optional: a different (e.g. stronger) model for deep dives and chat. Defaults to the main model.
    researchModel: process.env.OPENROUTER_RESEARCH_MODEL || '',
    // off | low | medium | high | default  (see llm.js)
    reasoning: process.env.OPENROUTER_REASONING || 'off',
  },
  refreshMinutes: num(process.env.REFRESH_MINUTES, 30),
  // How far back articles are kept / considered for grouping.
  articleMaxAgeHours: num(process.env.ARTICLE_MAX_AGE_HOURS, 72),
  maxArticlesPerFeed: num(process.env.MAX_ARTICLES_PER_FEED, 25),
  userAgent:
    process.env.FETCH_USER_AGENT ||
    'Mozilla/5.0 (compatible; OpenFrameNewsReader/1.0; personal news aggregator)',
};

export function hasLLM() {
  return Boolean(config.openrouter.apiKey);
}
