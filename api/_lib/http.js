import crypto from 'node:crypto';
import { DbError, derivedSecret } from './db.js';

const COOKIE = 'ml_session';
const SESSION_HOURS = 12;

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = req.body;
  if (raw === undefined || raw === null) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks);
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Responde un error con su motivo (HttpError/DbError) o 500 genérico. */
export function handleError(res, err) {
  if (err instanceof HttpError) return send(res, err.status, { error: err.message });
  if (err instanceof DbError) return send(res, 502, { error: err.message });
  if (err && err.code === '23505') return send(res, 409, { error: 'Ya existe un registro con ese dato.' });
  if (err && (err.code === '22P02' || err.code === '23503')) return send(res, 400, { error: 'Dato inválido.' });
  console.error(err);
  send(res, 500, { error: 'Error interno' });
}

// ---------------------------------------------------------------- contraseñas

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 32);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

// ---------------------------------------------------------------- sesión (cookie firmada)

function sign(data) {
  return crypto.createHmac('sha256', derivedSecret('session')).update(data).digest('base64url');
}

export function setSession(res, user, { remember = false } = {}) {
  const hours = remember ? 24 * 30 : SESSION_HOURS;
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      roles: Array.isArray(user.roles) ? user.roles.join(',') : String(user.roles || ''),
      exp: Date.now() + hours * 3600e3,
    }),
  ).toString('base64url');
  const value = `${payload}.${sign(payload)}`;
  const secure = process.env.LOCAL_DEV ? '' : ' Secure;';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${hours * 3600}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Datos firmados de la sesión (id, nombre, email, roles) o null. */
export function sessionData(req) {
  const cookies = Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim().split('='))
      .filter((p) => p.length >= 2)
      .map(([k, ...v]) => [k, v.join('=')]),
  );
  const raw = cookies[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // Cookies viejas (sin roles) obligan a entrar de nuevo.
    if (!data.id || typeof data.roles !== 'string' || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function sessionUserId(req) {
  return sessionData(req)?.id || null;
}

/** Datos públicos de un usuario (nunca la contraseña). */
export function publicUser(u) {
  return {
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    roles: String(u.roles || '').split(',').map((r) => r.trim()).filter(Boolean),
    activo: u.activo !== false && u.activo !== 'no',
  };
}
