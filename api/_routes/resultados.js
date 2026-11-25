// Resultados de contenido y atribución (solo admin).
//  - GET /resultados            → embudo por contenido (filtrado por la FECHA DEL CONTENIDO).
//  - GET /resultados/atribucion → agendas o ventas del rango con su origen (manual / automático / sin).
//  - GET /resultados/huecos     → contenidos sin ángulo, posts sin formato e historias sin tipo.
// Modelo de atribución único (api/_lib/metrics.js → effectiveContentSql):
// manual > último contenido que la lead respondió antes de agendar.
import { query } from '../_lib/db.js';
import { HttpError } from '../_lib/http.js';
import { effectiveContentSql, NO_SHOW_RESULTS, SHOW_RESULTS, VENTAS_CERRADAS_SQL } from '../_lib/metrics.js';
import { dateOrNull, dayRange } from '../_lib/util.js';

const KINDS = ['post', 'story', 'ad'];

function contentRange(q) {
  const from = dateOrNull(q.from);
  const to = dateOrNull(q.to);
  if (!from || !to) throw new HttpError(400, 'Falta el rango de fechas (from y to)');
  return from <= to ? { from, to } : { from: to, to: from };
}

const num = (v) => Number(v || 0);

// Agendas con su contenido efectivo, resultado y cash de la venta (sin renovaciones).
// Cancelada = estatus «cancelado» o resultado «cancelada»: no es show ni no show.
const AGENDAS_CTE = `
  ag as (
    select v.id as venta_id, ${effectiveContentSql('v')} as contenido_id, v.presupuesto, v.fecha_llamada,
           r.resultado,
           (v.status = 'cancelado' or coalesce(r.resultado, '') = 'cancelada') as cancelada,
           vc.venta_id is not null as es_venta,
           coalesce(pc.cash, 0) as cash
      from ml_ventas v
      left join ml_resultados r on r.venta_id = v.id
      left join (${VENTAS_CERRADAS_SQL}) vc on vc.venta_id = v.id
      left join lateral (
        select sum(p.monto) as cash from ml_pagos p
         where p.cliente_id = vc.cliente_id and p.renovacion_id is null
      ) pc on true
     where v.contact_id <> '' or v.atrib_contenido_id is not null
  )`;

async function resultados(q) {
  const { from, to } = contentRange(q);
  const kind = KINDS.includes(q.kind) ? q.kind : '';
  const [row] = await query(
    `with items as (
       select c.id, c.kind, c.titulo, c.codigo, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.formato, c.tipo_story,
              c.angulo_id, a.nombre as angulo_nombre, c.gasto, c.estado
         from ml_contenido c
         left join ml_angulos a on a.id = c.angulo_id
        where c.fecha >= $1::date and c.fecha <= $2::date and ($3::text = '' or c.kind = $3::text)
     ),
     leads as (
       select e.contenido_id, count(distinct e.contact_id)::int as n
         from ml_eventos e
        where e.tipo = 'content_reply' and e.contact_id <> '' and e.contenido_id in (select id from items)
        group by e.contenido_id
     ),
     ${AGENDAS_CTE},
     funnel as (
       select ag.contenido_id,
              count(*)::int as agendas,
              count(*) filter (where ag.presupuesto = 'sin')::int as sin_presupuesto,
              count(*) filter (where ag.cancelada)::int as canceladas,
              count(*) filter (where not ag.cancelada and (ag.resultado is not null or ag.fecha_llamada <= now()))::int as llamadas,
              count(*) filter (where not ag.cancelada and ag.resultado = any($4::text[]))::int as shows,
              count(*) filter (where not ag.cancelada and ag.resultado = any($5::text[]))::int as no_shows,
              count(*) filter (where ag.es_venta)::int as ventas,
              coalesce(sum(ag.cash) filter (where ag.es_venta), 0) as cash
         from ag
        where ag.contenido_id in (select id from items)
        group by ag.contenido_id
     ),
     final as (
       select i.*, coalesce(l.n, 0) as leads,
              coalesce(f.agendas, 0) as agendas, coalesce(f.sin_presupuesto, 0) as sin_presupuesto,
              coalesce(f.canceladas, 0) as canceladas, coalesce(f.llamadas, 0) as llamadas,
              coalesce(f.shows, 0) as shows, coalesce(f.no_shows, 0) as no_shows,
              coalesce(f.ventas, 0) as ventas, coalesce(f.cash, 0) as cash
         from items i
         left join leads l on l.contenido_id = i.id
         left join funnel f on f.contenido_id = i.id
     ),
     antes as (
       select avg(t.n)::float as promedio, count(*)::int as ventas from (
         select (select count(distinct e.contenido_id) from ml_eventos e
                  where e.tipo = 'content_reply' and e.contenido_id is not null
                    and e.contact_id = x.contact_id and e.recibido <= x.fecha_venta) as n
           from (${VENTAS_CERRADAS_SQL}) x
          where x.contact_id <> ''
       ) t
     )
     select
       (select coalesce(json_agg(row_to_json(f) order by f.fecha, f.titulo), '[]'::json) from final f) as items,
       (select count(distinct e.contact_id)::int from ml_eventos e
         where e.tipo = 'content_reply' and e.contact_id <> '' and e.contenido_id in (select id from items)) as leads_personas,
       (select row_to_json(a) from antes a) as antes`,
    [from, to, kind, SHOW_RESULTS, NO_SHOW_RESULTS],
  );

  const items = (row.items || []).map((i) => ({
    id: i.id,
    kind: i.kind,
    titulo: i.titulo,
    codigo: i.codigo,
    fecha: i.fecha,
    estado: i.estado,
    formato: i.formato,
    tipoStory: i.tipo_story,
    anguloId: i.angulo_id,
    anguloNombre: i.angulo_nombre,
    gasto: i.gasto === null ? null : num(i.gasto),
    leads: num(i.leads),
    agendas: num(i.agendas),
    sinPresupuesto: num(i.sin_presupuesto),
    canceladas: num(i.canceladas),
    llamadas: num(i.llamadas),
    shows: num(i.shows),
    noShows: num(i.no_shows),
    ventas: num(i.ventas),
    cash: num(i.cash),
  }));
  const sum = (k) => items.reduce((a, i) => a + (i[k] || 0), 0);
  const gasto = items.reduce((a, i) => a + (i.gasto || 0), 0);
  const totals = {
    piezas: items.length,
    leads: sum('leads'),
    leadsPersonas: num(row.leads_personas),
    agendas: sum('agendas'),
    sinPresupuesto: sum('sinPresupuesto'),
    canceladas: sum('canceladas'),
    llamadas: sum('llamadas'),
    shows: sum('shows'),
    noShows: sum('noShows'),
    ventas: sum('ventas'),
    cash: sum('cash'),
    gasto,
  };
  // ROAS y costo por lead solo tienen sentido en Ads (con «Todo» el cash es de todo el contenido).
  totals.roas = kind === 'ad' && gasto > 0 ? totals.cash / gasto : null;
  totals.costoPorLead = kind === 'ad' && gasto > 0 && totals.leads > 0 ? gasto / totals.leads : null;
  const antes = row.antes || { promedio: null, ventas: 0 };
  return {
    from,
    to,
    kind,
    items,
    totals,
    antesDeComprar: { promedio: antes.promedio === null ? null : Number(antes.promedio), ventas: num(antes.ventas) },
  };
}

async function atribucion(q) {
  const scope = q.scope === 'ventas' ? 'ventas' : 'agendas';
  const { from, to } = await dayRange(q);
  const onlyNone = q.sinAtribucion === '1';
  // Agendas: por cuándo llegó la agenda. Ventas: por la fecha de venta (primer pago).
  const base =
    scope === 'ventas'
      ? `select v.*, x.fecha_venta as fecha, x.monto_total, x.pago_inicial, x.programa as venta_programa
           from (${VENTAS_CERRADAS_SQL}) x join ml_ventas v on v.id = x.venta_id
          where x.fecha_venta >= $1 and x.fecha_venta < $2`
      : `select v.*, v.agendada as fecha, null::numeric as monto_total, null::numeric as pago_inicial, '' as venta_programa
           from ml_ventas v
          where v.agendada >= $1 and v.agendada < $2`;
  const [row] = await query(
    `with b as (${base}),
     rows as (
       select b.id, b.nombre, b.fecha, b.contact_id, b.status,
              su.nombre as setter_nombre, cu.nombre as closer_nombre,
              r.resultado, coalesce(b.monto_total, r.monto_total) as monto_total, b.pago_inicial,
              (select coalesce(sum(p.monto), 0) from ml_clientes c join ml_pagos p on p.cliente_id = c.id
                where c.venta_id = b.id and p.renovacion_id is null) as cash,
              b.atrib_contenido_id, b.atrib_motivo,
              ${effectiveContentSql('b')} as contenido_id
         from b
         left join ml_usuarios su on su.id = b.setter_id
         left join ml_usuarios cu on cu.id = b.closer_id
         left join ml_resultados r on r.venta_id = b.id
     ),
     full_rows as (
       select rows.*, c.kind as contenido_kind, c.titulo as contenido_titulo, c.codigo as contenido_codigo,
              case when rows.atrib_contenido_id is not null then 'manual_contenido'
                   when rows.atrib_motivo <> '' then 'manual_motivo'
                   when rows.contenido_id is not null then 'auto'
                   else 'ninguna' end as origen
         from rows left join ml_contenido c on c.id = rows.contenido_id
     )
     select
       (select coalesce(json_agg(row_to_json(f) order by f.fecha desc), '[]'::json)
          from (select * from full_rows where not $3::boolean or origen = 'ninguna' order by fecha desc limit 2000) f) as rows,
       (select json_build_object(
          'total', count(*),
          'auto', count(*) filter (where origen = 'auto'),
          'manual', count(*) filter (where origen in ('manual_contenido', 'manual_motivo')),
          'ninguna', count(*) filter (where origen = 'ninguna'),
          'ticket', coalesce(sum(monto_total), 0),
          'cash', coalesce(sum(cash), 0)) from full_rows) as counts`,
    [from, to, onlyNone],
  );
  const rows = (row.rows || []).map((r) => ({
    id: r.id,
    nombre: r.nombre,
    fecha: r.fecha,
    contactId: r.contact_id,
    setter: r.setter_nombre || '',
    closer: r.closer_nombre || '',
    resultado: r.resultado || '',
    cancelada: r.status === 'cancelado',
    montoTotal: r.monto_total === null ? null : num(r.monto_total),
    pagoInicial: r.pago_inicial === null ? null : num(r.pago_inicial),
    cash: num(r.cash),
    origen: r.origen,
    motivo: r.atrib_motivo || '',
    contenido: r.contenido_id
      ? { id: r.contenido_id, kind: r.contenido_kind || '', titulo: r.contenido_titulo || '', codigo: r.contenido_codigo || '', existe: !!r.contenido_codigo }
      : null,
  }));
  const c = row.counts || {};
  return {
    scope,
    rows,
    counts: {
      total: num(c.total),
      auto: num(c.auto),
      manual: num(c.manual),
      ninguna: num(c.ninguna),
      ticket: num(c.ticket),
      cash: num(c.cash),
    },
  };
}

async function huecos() {
  const [row] = await query(
    `with leads as (
       select e.contenido_id, count(distinct e.contact_id)::int as n
         from ml_eventos e
        where e.tipo = 'content_reply' and e.contact_id <> '' and e.contenido_id is not null
        group by e.contenido_id
     ),
     ag as (
       select ${effectiveContentSql('v')} as contenido_id
         from ml_ventas v
        where v.contact_id <> '' or v.atrib_contenido_id is not null
     ),
     agendas as (
       select contenido_id, count(*)::int as n from ag where contenido_id is not null group by contenido_id
     ),
     items as (
       select c.id, c.kind, c.titulo, c.codigo, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.formato, c.tipo_story, c.angulo_id,
              coalesce(l.n, 0) as leads, coalesce(a.n, 0) as agendas
         from ml_contenido c
         left join leads l on l.contenido_id = c.id
         left join agendas a on a.contenido_id = c.id
     )
     select
       (select coalesce(json_agg(row_to_json(i) order by i.leads desc, i.fecha desc nulls last), '[]'::json)
          from items i
         where i.angulo_id is null or (i.kind = 'post' and i.formato = '') or (i.kind = 'story' and i.tipo_story = '')) as items,
       (select coalesce(sum(leads), 0)::int from items) as total_leads,
       (select coalesce(json_agg(json_build_object('kind', kind, 'leads', l) ), '[]'::json)
          from (select kind, sum(leads)::int as l from items group by kind) k) as leads_por_kind,
       (select coalesce(json_agg(json_build_object('id', id, 'nombre', nombre) order by orden, nombre), '[]'::json) from ml_angulos) as angulos,
       (select coalesce(json_agg(distinct formato), '[]'::json) from ml_contenido where formato <> '') as formatos,
       (select coalesce(json_agg(distinct tipo_story), '[]'::json) from ml_contenido where tipo_story <> '') as tipos_story`,
  );
  const leadsPorKind = Object.fromEntries((row.leads_por_kind || []).map((k) => [k.kind, num(k.leads)]));
  return {
    items: (row.items || []).map((i) => ({
      id: i.id,
      kind: i.kind,
      titulo: i.titulo,
      codigo: i.codigo,
      fecha: i.fecha,
      formato: i.formato,
      tipoStory: i.tipo_story,
      anguloId: i.angulo_id,
      leads: num(i.leads),
      agendas: num(i.agendas),
    })),
    totalLeads: num(row.total_leads),
    leadsPorKind,
    angulos: row.angulos || [],
    formatos: row.formatos || [],
    tiposStory: row.tipos_story || [],
  };
}

export const routes = [
  { method: 'GET', path: '/resultados', auth: 'admin', handler: ({ query: q }) => resultados(q) },
  { method: 'GET', path: '/resultados/atribucion', auth: 'admin', handler: ({ query: q }) => atribucion(q) },
  { method: 'GET', path: '/resultados/huecos', auth: 'admin', handler: () => huecos() },
];
