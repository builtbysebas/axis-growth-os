// Utilidades compartidas por los módulos de la API.
import { query } from './db.js';
import { HttpError } from './http.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidOrNull(v) {
  const s = String(v ?? '').trim();
  return UUID.test(s) ? s : null;
}

export function requireUuid(v, what = 'registro') {
  const id = uuidOrNull(v);
  if (!id) throw new HttpError(404, `No existe ese ${what}`);
  return id;
}

export function text(v, max = 2000) {
  return String(v ?? '').slice(0, max).trim();
}

export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function intOrNull(v) {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
}

/** ISO o null (acepta '2026-12-01T15:00' o ISO completo). */
export function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 'YYYY-MM-DD' o null. */
export function dateOrNull(v) {
  const s = String(v ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Sin nulls hacia la pantalla (espera texto); los numéricos de pg llegan como texto. */
export function out(row) {
  if (!row) return row;
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k] = v ?? '';
  return o;
}

/** Zona horaria del negocio (Ajustes). Todas las fechas por día se cortan en esta zona. */
let tzCache = { v: null, at: 0 };
export async function businessTz() {
  if (tzCache.v && Date.now() - tzCache.at < 60_000) return tzCache.v;
  const [r] = await query("select value from ml_settings where key = 'zona'");
  tzCache = { v: r?.value || 'America/Lima', at: Date.now() };
  return tzCache.v;
}
export function clearTzCache() {
  tzCache = { v: null, at: 0 };
}

/**
 * Rango de días (YYYY-MM-DD, ambos inclusive) → instantes [desde, hasta) en la zona del negocio.
 * Devuelve { from, to, tz } para usar en SQL como: col >= $from and col < $to.
 */
export async function dayRange(q) {
  const tz = await businessTz();
  const from = dateOrNull(q.from);
  const to = dateOrNull(q.to);
  if (!from || !to) throw new HttpError(400, 'Falta el rango de fechas (from y to)');
  const [r] = await query(
    `select (($1::date)::timestamp at time zone $3) as f, ((($2::date) + 1)::timestamp at time zone $3) as t`,
    [from, to, tz],
  );
  return { from: r.f, to: r.t, fromDay: from, toDay: to, tz };
}

/** Puede editar una agenda: admin, o es su setter/closer, o la agenda no tiene a nadie. */
export function canEditVenta(user, v) {
  if (user.roles.includes('admin')) return true;
  if (!v.setter_id && !v.closer_id) return true;
  return v.setter_id === user.id || v.closer_id === user.id;
}

export function isAdmin(user) {
  return !!user && user.roles.includes('admin');
}
