// Ayuda para las pruebas: levanta un Postgres en memoria (PGlite) y llama a la
// API real (api/main.js) como lo haría Vercel, guardando la cookie de sesión.
//
//   import { setup, teardown, api, login, newJar } from './harness.mjs';
//   before(setup); after(teardown);
//   const r = await api('POST', '/ventas', { body: {...} });   // r.status, r.json
import { startLocalDb } from './localdb.mjs';

let db;
let handler;
export const jar = { cookie: '' };

export async function setup() {
  db = await startLocalDb();
  process.env.DATABASE_URL = db.url;
  process.env.DB_POOL_MAX = '1';
  process.env.LOCAL_DEV = '1';
  handler = (await import('../api/main.js')).default;
}

export async function teardown() {
  const { resetForTests } = await import('../api/_lib/db.js');
  await resetForTests();
  await db.stop();
}

/** Llama la API. opts: { body, headers, cookie } (cookie por defecto = la del jar). */
export async function api(method, path, { body, headers = {}, cookie = jar.cookie, jarRef = jar } = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const req = {
    method,
    url: `/api${path}`,
    headers: { host: 'localhost', cookie, 'content-type': 'application/json', ...headers },
    body: raw,
  };
  const outp = { status: 200, headers: {}, body: '' };
  const res = {
    set statusCode(v) { outp.status = v; },
    get statusCode() { return outp.status; },
    writableEnded: false,
    setHeader(k, v) { outp.headers[k.toLowerCase()] = v; },
    end(s) { outp.body = s; this.writableEnded = true; },
  };
  await handler(req, res);
  const setCookie = outp.headers['set-cookie'];
  if (setCookie && jarRef) jarRef.cookie = setCookie.split(';')[0];
  let json = null;
  try { json = outp.body ? JSON.parse(outp.body) : null; } catch { json = outp.body; }
  return { status: outp.status, json };
}

/** Crea el primer admin (si no existe) y deja la sesión en el jar. */
export async function adminSession(email = 'admin@test.com', password = 'clave-larga-1') {
  const r = await api('POST', '/setup', { body: { nombre: 'Admin', email, password } });
  if (r.status === 409) await api('POST', '/auth/login', { body: { email, password }, cookie: '' });
  return jar.cookie;
}

/** Crea un usuario con roles (necesita sesión de admin en el jar) y devuelve { id, cookie }. */
export async function userSession({ nombre, email, roles, password = 'clave-larga-9' }) {
  const adminCookie = jar.cookie;
  const r = await api('POST', '/usuarios', { body: { nombre, email, roles, password } });
  if (r.status !== 200) throw new Error(`No se pudo crear el usuario: ${JSON.stringify(r.json)}`);
  const own = { cookie: '' };
  await api('POST', '/auth/login', { body: { email, password }, cookie: '', jarRef: own });
  jar.cookie = adminCookie;
  return { id: r.json.usuario.id, cookie: own.cookie };
}
