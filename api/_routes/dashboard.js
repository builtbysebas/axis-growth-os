// Dashboard (solo admin): números generales, de dónde viene el cash y las agendas,
// y los números por setter / closer. Las fórmulas salen de api/_lib/metrics.js
// (mismas definiciones que la versión completa); acá solo se arma lo propio del tablero.
import { query } from '../_lib/db.js';
import { HttpError } from '../_lib/http.js';
import { effectiveContentSql, metrics, metricsByRole } from '../_lib/metrics.js';
import { dayRange } from '../_lib/util.js';

const n = (v) => Number(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- fuentes (atribución)
// Fuente de una venta/agenda: contenido atribuido (manual > último contenido que
// respondió por ManyChat antes de agendar) o el motivo manual; si no, «Sin atribución».
//   story → «Story · <tipo de story>»   post → «Contenido corto · <formato>»   ad → «Ads»
function normalizeLabel(v) {
  const t = String(v || '').trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function classifySource(row) {
  if (row.ct_id) {
    const item = row.ct_titulo || row.ct_codigo || null;
    if (row.ct_kind === 'story') {
      const t = String(row.ct_tipo_story || '').trim();
      return { key: `story:${t.toLowerCase()}`, label: t ? `Story · ${t}` : 'Story · sin tipo', group: 'story', item };
    }
    if (row.ct_kind === 'ad') return { key: 'ad', label: 'Ads', group: 'ad', item };
    const f = String(row.ct_formato || '').trim();
    return { key: `post:${f.toLowerCase()}`, label: f ? `Contenido corto · ${f}` : 'Contenido corto', group: 'post', item };
  }
  if (String(row.atrib_motivo || '').trim()) {
    const label = normalizeLabel(row.atrib_motivo);
    return { key: `manual:${label.toLowerCase()}`, label, group: 'manual', item: null };
  }
  return { key: 'none', label: 'Sin atribución', group: 'none', item: null };
}

// Contenido efectivo de la agenda `v` (puede ser null) → columnas ct_*.
const CONTENT_JOIN = `
  left join lateral (select ${effectiveContentSql('v')} as cid) ec on true
  left join ml_contenido ct on ct.id = ec.cid`;
const CONTENT_COLS = `ct.id as ct_id, ct.kind as ct_kind, ct.tipo_story as ct_tipo_story, ct.formato as ct_formato,
  ct.titulo as ct_titulo, ct.codigo as ct_codigo, v.atrib_motivo`;

// Primer pago (sin renovación) de cada cliente = el pago inicial de su venta.
const FIRST_PAYMENT_JOIN = `
  left join lateral (
    select p.id from ml_pagos p
     where p.cliente_id = c.id and p.renovacion_id is null
     order by p.pagado, p.creado, p.id limit 1
  ) fp on true`;

function topOf(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([title, value]) => ({ title, value: round2(value) }));
}

/** Cash del rango por fuente. Cada pago va a la fuente de su venta; las renovaciones aparte. */
export async function cashBySource(range) {
  const rows = await query(
    `select pg.monto, pg.renovacion_id, c.id as cliente_id, (pg.id = fp.id) as es_inicial, ${CONTENT_COLS}
       from ml_pagos pg
       join ml_clientes c on c.id = pg.cliente_id
       left join ml_ventas v on v.id = c.venta_id
       ${FIRST_PAYMENT_JOIN}
       ${CONTENT_JOIN}
      where pg.pagado >= $1 and pg.pagado < $2`,
    [range.from, range.to],
  );
  const by = new Map();
  let total = 0;
  for (const r of rows) {
    const amount = n(r.monto);
    total += amount;
    const src = r.renovacion_id ? { key: 'renewal', label: 'Renovaciones', group: 'renewal', item: null } : classifySource(r);
    const s = by.get(src.key) || { key: src.key, label: src.label, group: src.group, value: 0, pagos: 0, ventas: new Set(), top: new Map() };
    s.value += amount;
    s.pagos += 1;
    if (!r.renovacion_id && r.es_inicial) s.ventas.add(r.cliente_id);
    if (src.item) s.top.set(src.item, (s.top.get(src.item) || 0) + amount);
    by.set(src.key, s);
  }
  const sources = [...by.values()]
    .map((s) => ({ key: s.key, label: s.label, group: s.group, value: round2(s.value), pagos: s.pagos, ventas: s.ventas.size, top: topOf(s.top) }))
    .sort((a, b) => b.value - a.value);
  return { total: round2(total), sources };
}

/** Agendas del rango con presupuesto (sin canceladas) por fuente; «ventas» = cuántas ya compraron. */
export async function bookingsBySource(range) {
  const rows = await query(
    `select v.id, (r.resultado = 'venta') as vendida, ${CONTENT_COLS}
       from ml_ventas v
       left join ml_resultados r on r.venta_id = v.id
       ${CONTENT_JOIN}
      where v.agendada >= $1 and v.agendada < $2 and v.presupuesto = 'con'
        and v.status <> 'cancelado' and coalesce(r.resultado, '') <> 'cancelada'`,
    [range.from, range.to],
  );
  const by = new Map();
  for (const r of rows) {
    const src = classifySource(r);
    const s = by.get(src.key) || { key: src.key, label: src.label, group: src.group, value: 0, ventas: 0, top: new Map() };
    s.value += 1;
    if (r.vendida) s.ventas += 1;
    if (src.item) s.top.set(src.item, (s.top.get(src.item) || 0) + 1);
    by.set(src.key, s);
  }
  const sources = [...by.values()]
    .map((s) => ({ key: s.key, label: s.label, group: s.group, value: s.value, ventas: s.ventas, top: topOf(s.top) }))
    .sort((a, b) => b.value - a.value);
  return { total: rows.length, sources };
}

async function fuentes(range) {
  const [cash, agendas] = await Promise.all([cashBySource(range), bookingsBySource(range)]);
  return { cash, agendas };
}

// ---------------------------------------------------------------- EOD por setter
// Suma de las respuestas numéricas de las preguntas (activas o no) cuyo texto
// normalizado es uno de estos (si la dueña renombra una pregunta, deja de sumar).
export const EOD_KEYS = {
  outbound: 'outbound',
  'respuestas a outbound': 'respOutbound',
  inbound: 'inbound',
  'follow ups': 'followUps',
  followups: 'followUps',
};

export function normQuestion(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function eodSums(range, userIds) {
  if (!userIds.length) return new Map();
  const [preguntas, rows] = await Promise.all([
    query('select id, texto from ml_eod_preguntas'),
    query(
      `select e.user_id, kv.key as pregunta_id,
              sum(case when trim(replace(kv.value, ',', '.')) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                       then trim(replace(kv.value, ',', '.'))::numeric end) as total,
              count(*) filter (where trim(replace(kv.value, ',', '.')) ~ '^-?[0-9]+(\\.[0-9]+)?$')::int as n
         from ml_eod_envios e,
              jsonb_each_text(case when jsonb_typeof(e.respuestas) = 'object' then e.respuestas else '{}'::jsonb end) kv
        where e.fecha >= $1::date and e.fecha <= $2::date and e.user_id = any($3::uuid[])
        group by e.user_id, kv.key`,
      [range.fromDay, range.toDay, userIds],
    ),
  ]);
  const keyOf = new Map();
  for (const p of preguntas) {
    const k = EOD_KEYS[normQuestion(p.texto)];
    if (k) keyOf.set(String(p.id), k);
  }
  const out = new Map();
  for (const r of rows) {
    const k = keyOf.get(String(r.pregunta_id));
    if (!k || !r.n) continue;
    const u = out.get(r.user_id) || {};
    u[k] = (u[k] || 0) + n(r.total);
    out.set(r.user_id, u);
  }
  return out;
}

function withEod(e = {}) {
  const v = (k) => (e[k] === undefined ? null : round2(e[k]));
  const outbound = v('outbound');
  const respOutbound = v('respOutbound');
  const inbound = v('inbound');
  return {
    outbound,
    respOutbound,
    inbound,
    followUps: v('followUps'),
    pctRespOutbound: outbound > 0 && respOutbound !== null ? (respOutbound / outbound) * 100 : null,
    nuevasConversaciones: inbound === null && respOutbound === null ? null : (inbound || 0) + (respOutbound || 0),
  };
}

// ---------------------------------------------------------------- rutas
export const routes = [
  {
    // Pestaña General: métricas + fuentes del cash y de las agendas (un solo pedido).
    method: 'GET',
    path: '/dashboard',
    auth: 'admin',
    handler: async ({ query: q }) => {
      const range = await dayRange(q);
      const [m, f] = await Promise.all([metrics(range), fuentes(range)]);
      return { range: { from: range.fromDay, to: range.toDay }, metrics: m, fuentes: f };
    },
  },
  {
    method: 'GET',
    path: '/dashboard/fuentes',
    auth: 'admin',
    handler: async ({ query: q }) => fuentes(await dayRange(q)),
  },
  {
    // Cada pago del rango, con su tipo y de qué venta viene.
    method: 'GET',
    path: '/dashboard/cash',
    auth: 'admin',
    handler: async ({ query: q }) => {
      const range = await dayRange(q);
      const rows = await query(
        `select pg.id, pg.monto, pg.pagado, pg.metodo, pg.nota,
                c.id as cliente_id, c.nombre as cliente,
                s.nombre as setter, cl.nombre as closer, co.nombre as coach,
                case when pg.renovacion_id is not null then 'renovacion'
                     when pg.id = fp.id then 'venta_nueva' else 'cuota' end as tipo
           from ml_pagos pg
           join ml_clientes c on c.id = pg.cliente_id
           left join ml_ventas v on v.id = c.venta_id
           left join ml_usuarios s on s.id = v.setter_id
           left join ml_usuarios cl on cl.id = v.closer_id
           left join ml_usuarios co on co.id = c.coach_id
           ${FIRST_PAYMENT_JOIN}
          where pg.pagado >= $1 and pg.pagado < $2
          order by pg.pagado desc, pg.id`,
        [range.from, range.to],
      );
      const pagos = rows.map((r) => ({
        id: r.id,
        fecha: r.pagado,
        clienteId: r.cliente_id,
        cliente: r.cliente,
        monto: n(r.monto),
        metodo: r.metodo || '',
        nota: r.nota || '',
        tipo: r.tipo,
        setter: r.setter || '',
        closer: r.closer || '',
        coach: r.coach || '',
      }));
      const totales = { total: 0, venta_nueva: 0, cuota: 0, renovacion: 0 };
      for (const p of pagos) {
        totales.total += p.monto;
        totales[p.tipo] += p.monto;
      }
      for (const k of Object.keys(totales)) totales[k] = round2(totales[k]);
      return { range: { from: range.fromDay, to: range.toDay }, pagos, totales };
    },
  },
  {
    // Pestañas Setters / Closers: una fila por persona activa con ese rol.
    method: 'GET',
    path: '/dashboard/equipo',
    auth: 'admin',
    handler: async ({ query: q }) => {
      const rol = String(q.rol || '');
      if (!['setter', 'closer'].includes(rol)) throw new HttpError(400, 'Elige setters o closers');
      const range = await dayRange(q);
      const rows = await metricsByRole(range, rol);
      const eod = rol === 'setter' ? await eodSums(range, rows.map((r) => r.user.id)) : null;
      const filas = rows.map(({ user, ...m }) => ({
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        ...m,
        ...(eod ? withEod(eod.get(user.id)) : {}),
      }));
      return { rol, range: { from: range.fromDay, to: range.toDay }, filas };
    },
  },
];
