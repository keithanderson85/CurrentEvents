import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

// A tiny JSON-file store. Good enough for a single-user app; swap for SQLite if it grows.
const file = () => path.join(config.dataDir, 'store.json');

const empty = () => ({ articles: {}, events: {}, settings: {}, meta: {} });

let state = empty();
let saveTimer = null;

export function load() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    state = { ...empty(), ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[store] could not read store, starting fresh:', e.message);
    state = empty();
  }
  return state;
}

export function db() {
  return state;
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

export function flush() {
  clearTimeout(saveTimer);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file());
}

export const newId = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');
export const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 14);

export function setting(name, fallback) {
  const v = state.settings?.[name];
  return v === undefined || v === '' ? fallback : v;
}
