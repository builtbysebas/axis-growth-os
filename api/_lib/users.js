import { query } from './db.js';
import { HttpError, publicUser, sessionData } from './http.js';

export const USER_COLS = 'id, nombre, email, roles, activo, creado';

export async function findUserByEmail(email) {
  const rows = await query('select * from ml_usuarios where email = $1', [String(email || '').trim().toLowerCase()]);
  return rows[0] || null;
}

/**
 * Usuario de la sesión, sin consultar la base: nombre y roles viajan firmados en
 * la cookie. Que siga activo se revisa en /api/data (que lee los usuarios igual):
 * una persona desactivada pierde el acceso la próxima vez que se carga la pantalla.
 */
export function requireUser(req, { role } = {}) {
  const s = sessionData(req);
  if (!s) throw new HttpError(401, 'Inicia sesión');
  const pub = publicUser(s);
  const need = role ? (Array.isArray(role) ? role : [role]) : [];
  if (need.length && !pub.roles.includes('admin') && !need.some((r) => pub.roles.includes(r))) {
    throw new HttpError(403, 'No tienes permiso para esto');
  }
  return pub;
}

/** 401 si el usuario ya no existe o está desactivado. */
export function assertStillActive(user, usuarios) {
  const u = usuarios.find((x) => x.id === user.id);
  if (!u || u.activo === false || u.activo === 'no') throw new HttpError(401, 'Inicia sesión');
  return publicUser(u);
}
