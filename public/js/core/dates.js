// Fechas por día en la zona horaria del negocio (Ajustes → zona; por defecto Lima).
// Presets de rango iguales a la versión completa (por defecto «Este mes»).

let TZ = 'America/Lima';
export function setTimeZone(tz) {
  if (tz) TZ = tz;
}
export function timeZone() {
  return TZ;
}

/** 'YYYY-MM-DD' de hoy (o de un instante) en la zona del negocio. */
export function todayStr(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function monthRange(offset = 0, base = todayStr()) {
  const [y, m] = base.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(y, m + offset, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export const DEFAULT_PRESET = 'month';
export const PRESETS = [
  { key: 'month', label: 'Este mes' },
  { key: 'prev_month', label: 'Mes pasado' },
  { key: 'today', label: 'Hoy' },
  { key: 'yesterday', label: 'Ayer' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
  { key: 'custom', label: 'Personalizado' },
];

/** { from, to } (YYYY-MM-DD, ambos inclusive) o null si el personalizado está incompleto. */
export function rangeForPreset(preset, customFrom = '', customTo = '') {
  const t = todayStr();
  if (preset === 'month') return monthRange(0);
  if (preset === 'prev_month') return monthRange(-1);
  if (preset === 'today') return { from: t, to: t };
  if (preset === 'yesterday') {
    const y = addDays(t, -1);
    return { from: y, to: y };
  }
  if (preset === '7d') return { from: addDays(t, -6), to: t };
  if (preset === '30d') return { from: addDays(t, -29), to: t };
  if (!customFrom || !customTo) return null;
  return customFrom <= customTo ? { from: customFrom, to: customTo } : { from: customTo, to: customFrom };
}

function fmtDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' }).replace('.', '');
}

export function rangeLabel(r) {
  if (!r) return '';
  return r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
}

/** Lunes de la semana de una fecha. */
export function weekStart(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return addDays(s, -((dow + 6) % 7));
}
