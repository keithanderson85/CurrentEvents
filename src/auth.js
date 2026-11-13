import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, save, newId } from './store.js';

// Accounts, sessions and password resets. Everything lives in the JSON store.
// Passwords are stored as salted scrypt hashes; session and reset tokens are stored hashed,
// so a copy of the data file can't be used to log in.

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'ofn_session';
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();

const tables = () => {
  const s = db();
  s.users = s.users || {};
  s.sessions = s.sessions || {};
  s.resets = s.resets || {};
  return s;
};

export const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt } : null);
export const userCount = () => Object.keys(tables().users).length;
export const listUsers = () =>
  Object.values(tables().users)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(publicUser);
const byEmail = (email) => Object.values(tables().users).find((u) => u.email === normEmail(email));
export const findUserByEmail = byEmail;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored || '').split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password of at least 8 characters.');
  if (password.length > 200) throw new Error('That password is too long.');
}

// The invite code new people need. Set in Settings by the admin, or SIGNUP_CODE in .env.
export const inviteCode = () => db().settings.inviteCode || process.env.SIGNUP_CODE || '';
export function setInviteCode(code) {
  db().settings.inviteCode = String(code || '').trim().slice(0, 100);
  save();
}
const sameText = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(String(a))), Buffer.from(sha(String(b))));

export async function signup({ email, name, password, code }) {
  const s = tables();
  email = normEmail(email);
  // A username is fine; an email address is only needed for password reset emails.
  if (!/^[^\s]{3,200}$/.test(email)) throw new Error('Choose a username (or email) of at least 3 characters, with no spaces.');
  checkPassword(password);
  const first = userCount() === 0;
  const given = String(code || '').trim();
  if (first) {
    // The first account becomes the admin. If SIGNUP_CODE is set in .env it is required even here.
    if (process.env.SIGNUP_CODE && !sameText(given, process.env.SIGNUP_CODE)) throw new Error('That invite code isn’t right.');
  } else {
    const need = inviteCode();
    if (!need) throw new Error('Sign-ups are closed. Ask the person who runs this site for an invite code.');
    if (!sameText(given, need)) throw new Error('That invite code isn’t right.');
  }
  if (byEmail(email)) throw new Error('That username or email is already taken. Try logging in.');
  const user = {
    id: newId('u_'),
    email,
    name: String(name || '').trim().slice(0, 60) || email.split('@')[0],
    pass: await hashPassword(password),
    role: first ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
  };
  s.users[user.id] = user;
  if (first) adoptExistingData(user.id);
  save();
  return user;
}

// Everything personal made before logins existed (notes, chats, pins, deep dives, custom
// events, the assistant conversation) goes to the first account.
function adoptExistingData(uid) {
  const s = db();
  for (const ev of Object.values(s.events)) {
    if (ev.notes?.length || ev.chat?.length || ev.pinned || ev.research?.length) {
      ev.users = ev.users || {};
      ev.users[uid] = { notes: ev.notes || [], chat: ev.chat || [], research: ev.research || [], pinned: Boolean(ev.pinned) };
    }
    delete ev.notes;
    delete ev.chat;
    delete ev.research;
    delete ev.pinned;
    if (ev.manual && !ev.ownerId) ev.ownerId = uid;
  }
  if (s.assistant) {
    s.assistants = s.assistants || {};
    s.assistants[uid] = s.assistant;
    delete s.assistant;
  }
}

export async function login({ email, password }) {
  const user = byEmail(email);
  // Hash even when the account doesn't exist, so timing doesn't reveal which emails are registered.
  let ok = false;
  if (user) ok = await verifyPassword(String(password || ''), user.pass);
  else await hashPassword('x');
  if (!ok) throw new Error('Wrong username or password.');
  return user;
}

export async function changePassword(user, current, next) {
  if (!(await verifyPassword(String(current || ''), user.pass))) throw new Error('Your current password isn’t right.');
  checkPassword(next);
  user.pass = await hashPassword(next);
  save();
}

// ---------- Sessions ----------

export function startSession(res, req, user) {
  const s = tables();
  const token = crypto.randomBytes(32).toString('base64url');
  s.sessions[sha(token)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5 };
  save();
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
const tokenFrom = (req) => {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
  return m ? m[1] : '';
};
export function userFromRequest(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const s = tables();
  const key = sha(token);
  const sess = s.sessions[key];
  if (!sess) return null;
  if (sess.expires < Date.now()) {
    s.sessions[key] = undefined;
    return null;
  }
  return s.users[sess.userId] || null;
}
function dropWhere(table, test) {
  for (const k of Object.keys(table)) if (!table[k] || test(table[k])) Reflect.deleteProperty(table, k);
}
export function endSession(req, res) {
  const token = tokenFrom(req);
  if (token) Reflect.deleteProperty(tables().sessions, sha(token));
  save();
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
const endAllSessions = (userId) => dropWhere(tables().sessions, (v) => v.userId === userId);
export function pruneAuth() {
  const s = tables();
  const now = Date.now();
  dropWhere(s.sessions, (v) => v.expires < now);
  dropWhere(s.resets, (v) => v.expires < now);
}

// ---------- Password reset ----------

export function createResetToken(userId) {
  const s = tables();
  dropWhere(s.resets, (v) => v.userId === userId); // one live link per person
  const token = crypto.randomBytes(32).toString('base64url');
  s.resets[sha(token)] = { userId, expires: Date.now() + RESET_MINUTES * 60e3 };
  save();
  return token;
}
export async function resetPassword(token, password) {
  const s = tables();
  const key = sha(String(token || ''));
  const r = s.resets[key];
  if (!r || r.expires < Date.now()) throw new Error('That reset link has expired or was already used. Ask for a new one.');
  const user = s.users[r.userId];
  if (!user) throw new Error('That account no longer exists.');
  checkPassword(password);
  user.pass = await hashPassword(password);
  Reflect.deleteProperty(s.resets, key);
  endAllSessions(user.id); // log out everywhere
  save();
  return user;
}

// Remove an account and everything that belonged to it.
export function removeUser(id) {
  const s = tables();
  if (!s.users[id]) return;
  endAllSessions(id);
  dropWhere(s.resets, (v) => v.userId === id);
  Reflect.deleteProperty(s.users, id);
  for (const [eid, ev] of Object.entries(s.events)) {
    if (ev.ownerId === id) Reflect.deleteProperty(s.events, eid);
    else if (ev.users) Reflect.deleteProperty(ev.users, id);
  }
  if (s.assistants) Reflect.deleteProperty(s.assistants, id);
  save();
}

// ---------- Email ----------

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
export const emailEnabled = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
export async function sendResetEmail(user, link) {
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || `OpenFrame News <${process.env.SMTP_USER}>`,
    to: user.email,
    subject: 'Reset your OpenFrame News password',
    text: `Hi ${user.name},\n\nSomeone asked to reset the password for your OpenFrame News account. Open this link to choose a new one. It works once and expires in ${RESET_MINUTES} minutes.\n\n${link}\n\nIf this wasn't you, ignore this email and your password stays the same.\n`,
  });
}

// ---------- Rate limiting (per address, in memory) ----------

const hits = new Map();
export function rateLimit(req, bucket, { max = 10, minutes = 15 } = {}) {
  const key = `${bucket}:${req.ip}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < minutes * 60e3);
  if (list.length >= max) throw Object.assign(new Error(`Too many attempts. Try again in ${minutes} minutes.`), { status: 429 });
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
}

// ---------- Per-person data on a shared event ----------

// Notes, chat, deep dives and the pin for one person on one event.
export function mine(ev, uid) {
  ev.users = ev.users || {};
  const m = (ev.users[uid] = ev.users[uid] || {});
  m.notes = m.notes || [];
  m.chat = m.chat || [];
  m.research = m.research || [];
  return m;
}
export const peek = (ev, uid) => ev.users?.[uid] || { notes: [], chat: [], research: [], pinned: false };
// Does anyone have something saved on this event? (Such events are never cleaned up.)
export const anyUserData = (ev) => Object.values(ev.users || {}).some((m) => m.notes?.length || m.chat?.length || m.research?.length || m.pinned);
export const anyPinned = (ev) => Object.values(ev.users || {}).some((m) => m.pinned);
// Auto-gathered events are shared; custom events are visible only to the person who made them.
export const canSee = (ev, uid) => !ev.ownerId || ev.ownerId === uid;
