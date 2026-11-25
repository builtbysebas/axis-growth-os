// Métricas del negocio en UN solo lugar (dashboard, setters/closers, EOD, metas).
// Mismas definiciones que la versión completa:
//  - Agenda: agenda (ml_ventas) por la fecha en que llegó (`agendada`).
//  - Calificada: agenda que no terminó «Cancelada» (no califica).
//  - Llamadas debidas: fecha de llamada en el rango y ya pasada, sin canceladas.
//  - Show: resultado venta / no cerró / reserva. No show: no show / pidió reagendar.
//  - Show rate = shows ÷ llamadas debidas. Close rate = ventas ÷ shows (tope 100 %).
//  - Venta: resultado «venta»; su fecha es la del primer pago (sin renovaciones),
//    si no hay pago, la del resultado.
//  - Cash collected: todo lo cobrado en el rango (ventas nuevas, cuotas y renovaciones).
//    Por setter/closer NO cuentan renovaciones (no comisionan).
//  - Facturación: total vendido (ticket) de las ventas del rango + renovaciones del rango.
//  - AOV: promedio del pago inicial de las ventas del rango.
//  - Propuestas / links: avisos de ManyChat del setter; el mismo contacto vuelve a
//    contar solo si pasaron más de 30 días desde el aviso anterior del mismo tipo.
import { query } from './db.js';

export const SHOW_RESULTS = ['venta', 'no_cerro', 'reserva'];
export const NO_SHOW_RESULTS = ['no_show', 'pidio_reagendar'];

/** Ventas cerradas con su fecha de venta, pago inicial y personas (subconsulta SQL). */
export const VENTAS_CERRADAS_SQL = `
  select c.id as cliente_id, v.id as venta_id, v.setter_id, v.closer_id, v.contact_id,
         r.monto_total, r.programa, coalesce(fp.pagado, r.creado) as fecha_venta,
         coalesce(fp.monto, 0) as pago_inicial
    from ml_resultados r
    join ml_ventas v on v.id = r.venta_id
    join ml_clientes c on c.venta_id = v.id
    left join lateral (
      select p.pagado, p.monto from ml_pagos p
       where p.cliente_id = c.id and p.renovacion_id is null
       order by p.pagado limit 1
    ) fp on true
   where r.resultado = 'venta'`;

/**
 * Contenido al que se atribuye una agenda (SQL, devuelve uuid o null):
 * manual > último «respondió a un contenido» de ManyChat del mismo contacto
 * hasta 10 minutos después de agendar. `v` = alias de ml_ventas.
 */
export function effectiveContentSql(v = 'v') {
  return `coalesce(${v}.atrib_contenido_id, (
    select e.contenido_id from ml_eventos e
     where ${v}.atrib_motivo = '' and ${v}.contact_id <> '' and e.contact_id = ${v}.contact_id
       and e.tipo = 'content_reply' and e.contenido_id is not null
       and e.recibido <= ${v}.agendada + interval '10 minutes'
     order by e.recibido desc limit 1))`;
}

function personFilter(col, id, params) {
  if (!id) return '';
  params.push(id);
  return ` and ${col} = $${params.length}`;
}

const n = (v) => Number(v || 0);
const rate = (a, b) => (b > 0 ? Math.min(100, (a / b) * 100) : null);

/**
 * Métricas de un rango [from, to) (instantes) para todo el negocio o una persona.
 * opts: { setterId, closerId }
 */
export async function metrics(range, { setterId = null, closerId = null } = {}) {
  const { from, to } = range;
  const person = setterId ? 'setter' : closerId ? 'closer' : null;
  const pid = setterId || closerId;

  // Agendas
  let p = [from, to];
  const ag = await query(
    `select count(*)::int as agendas,
            count(*) filter (where v.status <> 'cancelado' and coalesce(r.resultado, '') <> 'cancelada')::int as calificadas,
            count(*) filter (where v.presupuesto = 'con')::int as con_presupuesto,
            count(*) filter (where v.presupuesto = 'sin')::int as sin_presupuesto,
            count(*) filter (where v.status = 'cancelado' or r.resultado = 'cancelada')::int as canceladas
       from ml_ventas v left join ml_resultados r on r.venta_id = v.id
      where v.agendada >= $1 and v.agendada < $2${person ? personFilter(`v.${person}_id`, pid, p) : ''}`,
    p,
  );

  // Llamadas debidas, shows y no shows
  p = [from, to, SHOW_RESULTS, NO_SHOW_RESULTS];
  const ll = await query(
    `select count(*)::int as llamadas,
            count(*) filter (where r.resultado = any($3))::int as shows,
            count(*) filter (where r.resultado = any($4))::int as no_shows,
            count(*) filter (where r.resultado is null)::int as sin_resultado
       from ml_ventas v left join ml_resultados r on r.venta_id = v.id
      where v.fecha_llamada >= $1 and v.fecha_llamada < $2 and v.fecha_llamada <= now()
        and v.status <> 'cancelado' and coalesce(r.resultado, '') <> 'cancelada'${person ? personFilter(`v.${person}_id`, pid, p) : ''}`,
    p,
  );

  // Ventas nuevas del rango
  p = [from, to];
  const vs = await query(
    `select count(*)::int as ventas, coalesce(sum(monto_total), 0) as facturacion_ventas, coalesce(avg(pago_inicial), 0) as aov
       from (${VENTAS_CERRADAS_SQL}) x
      where x.fecha_venta >= $1 and x.fecha_venta < $2${person ? personFilter(`x.${person}_id`, pid, p) : ''}`,
    p,
  );

  // Cash
  p = [from, to];
  const cash = await query(
    `select coalesce(sum(pg.monto), 0) as cash,
            coalesce(sum(pg.monto) filter (where pg.renovacion_id is null), 0) as cash_nuevo,
            coalesce(sum(pg.monto) filter (where pg.renovacion_id is not null), 0) as cash_renovaciones,
            count(*)::int as pagos
       from ml_pagos pg
       join ml_clientes c on c.id = pg.cliente_id
       left join ml_ventas v on v.id = c.venta_id
      where pg.pagado >= $1 and pg.pagado < $2${person ? ` and pg.renovacion_id is null${personFilter(`v.${person}_id`, pid, p)}` : ''}`,
    p,
  );

  // Renovaciones (solo global)
  const ren = person
    ? [{ renovaciones: 0, facturacion_renov: 0 }]
    : await query(
        `select count(*)::int as renovaciones, coalesce(sum(monto_total), 0) as facturacion_renov
           from ml_renovaciones where creado >= $1 and creado < $2`,
        [from, to],
      );

  // Propuestas y links (ManyChat): solo global o por setter
  let ev = [{ propuestas: 0, links: 0, respuestas: 0 }];
  if (!closerId) {
    p = [from, to];
    ev = await query(
      `select count(*) filter (where tipo = 'call_proposed')::int as propuestas,
              count(*) filter (where tipo = 'link_sent')::int as links,
              count(*) filter (where tipo = 'content_reply')::int as respuestas
         from (
           select e.*, lag(e.recibido) over (partition by e.contact_id, e.tipo order by e.recibido) as prev
             from ml_eventos e
         ) x
        where x.recibido >= $1 and x.recibido < $2
          and (x.prev is null or x.recibido - x.prev > interval '30 days')${setterId ? personFilter('x.setter_id', setterId, p) : ''}`,
      p,
    );
  }

  const a = ag[0];
  const l = ll[0];
  const v = vs[0];
  const c = cash[0];
  const r = ren[0];
  const e = ev[0];
  const ventas = n(v.ventas);
  return {
    agendas: n(a.agendas),
    calificadas: n(a.calificadas),
    conPresupuesto: n(a.con_presupuesto),
    sinPresupuesto: n(a.sin_presupuesto),
    canceladas: n(a.canceladas),
    llamadas: n(l.llamadas),
    shows: n(l.shows),
    noShows: n(l.no_shows),
    sinResultado: n(l.sin_resultado),
    showRate: rate(n(l.shows), n(l.llamadas)),
    ventas,
    closeRate: rate(ventas, n(l.shows)),
    facturacion: n(v.facturacion_ventas) + n(r.facturacion_renov),
    aov: ventas ? n(v.aov) : null,
    cash: n(c.cash),
    cashNuevo: n(c.cash_nuevo),
    cashRenovaciones: n(c.cash_renovaciones),
    pagos: n(c.pagos),
    renovaciones: n(r.renovaciones),
    propuestas: n(e.propuestas),
    links: n(e.links),
    respuestas: n(e.respuestas),
  };
}

/** Métricas por persona de un rol (setter | closer), solo usuarios activos con ese rol. */
export async function metricsByRole(range, role) {
  const users = await query(
    `select id, nombre, email from ml_usuarios where activo and $1 = any(string_to_array(roles, ',')) order by nombre`,
    [role],
  );
  const out = [];
  for (const u of users) {
    out.push({ user: u, ...(await metrics(range, role === 'setter' ? { setterId: u.id } : { closerId: u.id })) });
  }
  return out;
}
