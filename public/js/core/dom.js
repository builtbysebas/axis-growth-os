// Utilidades de pantalla sin librerías: HTML seguro, íconos, avatares y formatos.

/** Escapa texto para meterlo en HTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Plantilla → elemento (si hay uno solo) o fragmento. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html).trim();
  return t.content.childElementCount === 1 && t.content.childNodes.length === 1 ? t.content.firstElementChild : t.content;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Delegación de eventos: on(root, 'click', '[data-x]', (e, el) => ...). */
export function on(root, type, selector, fn) {
  const handler = (e) => {
    const el = e.target instanceof Element ? e.target.closest(selector) : null;
    if (el && root.contains(el)) fn(e, el);
  };
  root.addEventListener(type, handler);
  return () => root.removeEventListener(type, handler);
}

// ---------------------------------------------------------------- avatares (mismo criterio que la versión completa)
const PALETTE = ['#ec4b28', '#6366f1', '#10b981', '#f59e0b', '#0ea5e9', '#d946ef', '#84cc16', '#f43f5e'];

export function initialsOf(text) {
  const name = String(text || '').split('@')[0];
  const parts = name.split(/[._\s-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '?';
}

export function colorOf(id) {
  let hash = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function firstName(u) {
  return (u?.nombre || u?.email || '').trim().split(/\s+/)[0] || '';
}

// ---------------------------------------------------------------- formatos
const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** $1,234 (o con centavos si los tiene). */
export function money(n) {
  const v = Number(n);
  if (n === '' || n === null || n === undefined || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? money0.format(v) : money2.format(v);
}

export function num(n, digits = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('es-PE', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function pct(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

/** 12 nov, 3:40 p. m. */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('es-PE', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** 12 nov 2026 (acepta 'YYYY-MM-DD' sin correr el día por zona horaria). */
export function fmtDate(v, { year = true } = {}) {
  if (!v) return '';
  const s = String(v);
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, dd] = s.split('-').map(Number);
    d = new Date(y, m - 1, dd);
  } else d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('es-PE', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }).replace('.', '');
}

/** ISO → valor para <input type="datetime-local"> en hora local del navegador. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : '';
}

export function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

/** Texto normalizado para buscar: sin tildes ni mayúsculas. */
export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------------------------------------------------------------- íconos (los mismos trazos de la versión completa)
const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  doc: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>'),
  funnel: svg('<path d="M3 4h18l-7 9v6l-4 2v-8Z"/>'),
  check: svg('<path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z"/><path d="M6 5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2"/><path d="m9 13 2 2 4-4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.2c1.6.4 2.8 1.9 2.8 3.6 0 1.7-1.2 3.2-2.8 3.6"/><path d="M19 14.3c2 .6 3.5 2.4 3.5 4.7"/>'),
  power: svg('<path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  calendar: svg('<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'),
  chevronsLeft: svg('<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>'),
  chat: svg('<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.1Z"/><path d="M9 10h.01M12 10h.01M15 10h.01"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  money: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>'),
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>'),
  trend: svg('<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>'),
  spark: svg('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),
  crown: svg('<path d="m3 8 4 4 5-7 5 7 4-4-2 11H5Z"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
  kanban: svg('<rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="10" y="3" width="5" height="12" rx="1.5"/><rect x="17" y="3" width="4" height="8" rx="1.5"/>'),
};
