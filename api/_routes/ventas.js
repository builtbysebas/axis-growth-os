// CRM de Ventas: agendas (cards), etapas, notas, estatus y resultado de la llamada.
// Una llamada con resultado «venta» crea el Cliente y su pago inicial en la misma transacción.
import { query, tx } from '../_lib/db.js';
import { HttpError, publicUser } from '../_lib/http.js';
import { assertStillActive, USER_COLS } from '../_lib/users.js';
import {
  businessTz,
  canEditVenta,
  intOrNull,
  isAdmin,
  isoOrNull,
  numOrNull,
  out,
  requireUuid,
  text,
  uuidOrNull,
} from '../_lib/util.js';

const STATUSES = ['para_hoy', 'standby', 'ganado', 'perdido', 'cancelado'];
export const RESULTADOS = ['venta', 'no_show', 'no_cerro', 'cancelada', 'reserva', 'pidio_reagendar'];
const TEXT_FIELDS = ['nombre', 'telefono', 'email', 'instagram', 'contact_id', 'notas', 'presupuesto', 'origen'];

const VENTA_SELECT = `
  select v.*, r.resultado, r.programa as resultado_programa, r.monto_total as resultado_monto
    from ml_ventas v
    left join ml_resultados r on r.venta_id = v.id`;

/** Limpia lo que manda la pantalla (solo campos permitidos). */
function cleanVenta(b = {}) {
  const o = {};
  for (const f of TEXT_FIELDS) if (b[f] !== undefined) o[f] = text(b[f]);
  for (const f of ['etapa_id', 'setter_id', 'closer_id']) if (b[f] !== undefined) o[f] = uuidOrNull(b[f]);
  if (b.fecha_llamada !== undefined) o.fecha_llamada = isoOrNull(b.fecha_llamada);
  if (b.agendada !== undefined) o.agendada = isoOrNull(b.agendada) || new Date().toISOString();
  if (b.presupuesto !== undefined && !['con', 'sin', ''].includes(o.presupuesto)) o.presupuesto = '';
  return o;
}

async function loadVenta(id) {
  const [v] = await query(`${VENTA_SELECT} where v.id = $1`, [requireUuid(id, 'agenda')]);
  if (!v) throw new HttpError(404, 'No existe esa agenda');
  return v;
}

async function loadEditable(id, user) {
  const v = await loadVenta(id);
  if (!canEditVenta(user, v)) throw new HttpError(403, 'Esta agenda es de otra persona: solo la puede cambiar su setter, su closer o un admin.');
  return v;
}

/** Si la llamada vence/pasa, la próxima acción es la llamada; standby vencido vuelve a «para hoy». */
async function flipOverdueStandby() {
  await query(`update ml_ventas set status = 'para_hoy' where status = 'standby' and proxima_accion is not null and proxima_accion <= now()`);
}

async function stageOfType(c, tipo) {
  const { rows } = await c.query('select id from ml_etapas where tipo = $1 order by orden limit 1', [tipo]);
  return rows[0]?.id || null;
}

async function bottomOrder(c, etapaId) {
  const { rows } = await c.query('select coalesce(max(orden), 0) + 1 as o from ml_ventas where etapa_id is not distinct from $1', [etapaId]);
  return rows[0].o;
}

export const routes = [
  // ------------------------------------------------------------ lectura
  {
    method: 'GET',
    path: '/ventas',
    auth: 'user',
    handler: async ({ user }) => {
      await flipOverdueStandby();
      const [etapas, ventas, usuarios] = await Promise.all([
        query('select id, nombre, orden, tipo from ml_etapas order by orden, nombre'),
        query(`${VENTA_SELECT} order by v.orden, v.creado`),
        query(`select ${USER_COLS} from ml_usuarios order by nombre`),
      ]);
      assertStillActive(user, usuarios);
      return {
        etapas,
        ventas: ventas.map(out),
        usuarios: usuarios.map(publicUser).filter((u) => u.activo),
      };
    },
  },
  {
    method: 'GET',
    path: '/ventas/:id',
    auth: 'user',
    handler: async ({ params }) => {
      const v = await loadVenta(params.id);
      const [notas, resultado, cliente] = await Promise.all([
        query(
          `select n.id, n.texto, n.creado, u.nombre as autor from ml_venta_notas n
             left join ml_usuarios u on u.id = n.user_id where n.venta_id = $1 order by n.creado desc`,
          [v.id],
        ),
        query('select * from ml_resultados where venta_id = $1', [v.id]),
        query('select id, nombre from ml_clientes where venta_id = $1', [v.id]),
      ]);
      return { venta: out(v), notas, resultado: resultado[0] ? out(resultado[0]) : null, cliente: cliente[0] || null };
    },
  },

  // ------------------------------------------------------------ escribir
  {
    method: 'POST',
    path: '/ventas',
    auth: 'user',
    handler: async ({ body }) => {
      const { etapa_id: etapa = null, ...row } = cleanVenta(await body());
      if (!row.nombre) throw new HttpError(400, 'Falta el nombre');
      const v = await tx(async (c) => {
        const etapaId = etapa || (await c.query("select id from ml_etapas order by (tipo = 'entrada') desc, orden limit 1")).rows[0]?.id || null;
        const orden = await bottomOrder(c, etapaId);
        const cols = Object.keys(row);
        const vals = Object.values(row);
        const { rows } = await c.query(
          `insert into ml_ventas (etapa_id, orden, proxima_accion${cols.map((k) => `, ${k}`).join('')})
           values ($1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) returning id`,
          [etapaId, orden, row.fecha_llamada || new Date().toISOString(), ...vals],
        );
        return rows[0];
      });
      return { venta: out(await loadVenta(v.id)) };
    },
  },
  {
    method: 'PATCH',
    path: '/ventas/:id',
    auth: 'user',
    handler: async ({ params, body, user }) => {
      const before = await loadEditable(params.id, user);
      const patch = cleanVenta(await body());
      if ('nombre' in patch && !patch.nombre) throw new HttpError(400, 'Falta el nombre');
      const cols = Object.keys(patch);
      // La próxima acción sigue a la fecha de la llamada (salvo standby, que tiene la suya).
      if ('fecha_llamada' in patch && before.status !== 'standby') {
        cols.push('proxima_accion');
        patch.proxima_accion = patch.fecha_llamada || before.proxima_accion;
      }
      if (cols.length) {
        const sets = cols.map((c, i) => `${c} = $${i + 2}`).concat('actualizado = now()');
        await query(`update ml_ventas set ${sets.join(', ')} where id = $1`, [before.id, ...cols.map((c) => patch[c])]);
      }
      return { venta: out(await loadVenta(before.id)) };
    },
  },
  {
    method: 'DELETE',
    path: '/ventas/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'agenda');
      await query('delete from ml_ventas where id = $1', [id]);
      return { ok: true };
    },
  },
  {
    // Mover de columna / reordenar. beforeId = la card que queda debajo (null = al final).
    method: 'POST',
    path: '/ventas/:id/mover',
    auth: 'user',
    handler: async ({ params, body, user }) => {
      const v = await loadEditable(params.id, user);
      const b = await body();
      const etapaId = requireUuid(b.etapaId, 'columna');
      const beforeId = uuidOrNull(b.beforeId);
      await tx(async (c) => {
        const { rows: et } = await c.query('select tipo from ml_etapas where id = $1', [etapaId]);
        if (!et[0]) throw new HttpError(404, 'No existe esa columna');
        let orden;
        if (beforeId) {
          const { rows } = await c.query(
            `select orden, (select max(orden) from ml_ventas where etapa_id = $1 and orden < b.orden and id <> $3) as prev
               from ml_ventas b where b.id = $2`,
            [etapaId, beforeId, v.id],
          );
          if (rows[0]) orden = rows[0].prev == null ? rows[0].orden - 1 : (rows[0].prev + rows[0].orden) / 2;
        }
        if (orden === undefined) orden = await bottomOrder(c, etapaId);
        let status = v.status;
        const tipo = et[0].tipo;
        // Mover a «Perdido» = no se vendió (cancelado queda solo para el resultado «Cancelada»).
        if (tipo === 'perdido' && v.status !== 'cancelado') {
          if (v.fecha_llamada && new Date(v.fecha_llamada) < new Date() && !v.resultado) {
            throw new HttpError(409, 'Esta llamada ya pasó y no tiene resultado: carga primero el resultado (por ejemplo No show) antes de pasarla a Perdido.');
          }
          status = 'perdido';
        } else if (tipo === 'ganado') status = 'ganado';
        else if (v.status === 'perdido' || v.status === 'ganado') status = 'para_hoy';
        await c.query('update ml_ventas set etapa_id = $2, orden = $3, status = $4, actualizado = now() where id = $1', [v.id, etapaId, orden, status]);
      });
      return { venta: out(await loadVenta(v.id)) };
    },
  },
  {
    method: 'POST',
    path: '/ventas/:id/estatus',
    auth: 'user',
    handler: async ({ params, body, user }) => {
      const v = await loadEditable(params.id, user);
      const b = await body();
      if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Estatus inválido');
      let prox = isoOrNull(b.proximaAccion);
      if (b.status === 'standby' && !prox) throw new HttpError(400, 'Elige la fecha del recordatorio');
      if (b.status === 'para_hoy') prox = v.fecha_llamada && new Date(v.fecha_llamada) > new Date() ? v.fecha_llamada : new Date().toISOString();
      await query('update ml_ventas set status = $2, proxima_accion = coalesce($3, proxima_accion), actualizado = now() where id = $1', [v.id, b.status, prox]);
      return { venta: out(await loadVenta(v.id)) };
    },
  },
  {
    method: 'POST',
    path: '/ventas/:id/notas',
    auth: 'user',
    handler: async ({ params, body, user }) => {
      const v = await loadVenta(params.id);
      const t = text((await body()).texto, 5000);
      if (!t) throw new HttpError(400, 'Escribe la nota');
      const [n] = await query('insert into ml_venta_notas (venta_id, user_id, texto) values ($1, $2, $3) returning id, texto, creado', [v.id, user.id, t]);
      return { nota: { ...n, autor: user.nombre } };
    },
  },
  {
    method: 'PATCH',
    path: '/ventas/:id/atribucion',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const v = await loadVenta(params.id);
      const b = await body();
      const contenido = uuidOrNull(b.contenidoId);
      const motivo = contenido ? '' : text(b.motivo, 200);
      await query('update ml_ventas set atrib_contenido_id = $2, atrib_motivo = $3, actualizado = now() where id = $1', [v.id, contenido, motivo]);
      return { venta: out(await loadVenta(v.id)) };
    },
  },

  // ------------------------------------------------------------ resultado de la llamada
  {
    method: 'PUT',
    path: '/ventas/:id/resultado',
    auth: ['closer', 'setter'],
    handler: async ({ params, body, user }) => {
      const v = await loadEditable(params.id, user);
      const b = await body();
      const resultado = String(b.resultado || '');
      if (!RESULTADOS.includes(resultado)) throw new HttpError(400, 'Elige el resultado de la llamada');
      const esCloser = isAdmin(user) || user.roles.includes('closer');
      if (!esCloser && !['cancelada', 'pidio_reagendar'].includes(resultado)) {
        throw new HttpError(403, 'Un setter solo puede marcar «Cancelada» o «Pidió reagendar».');
      }
      const motivo = text(b.motivo, 2000);
      if (resultado === 'cancelada' && !motivo) throw new HttpError(400, 'Escribe por qué se canceló');
      const programa = text(b.programa, 200);
      const montoTotal = numOrNull(b.montoTotal);
      const pagoInicial = numOrNull(b.pagoInicial);
      const meses = intOrNull(b.meses);
      if (resultado === 'venta') {
        if (!programa) throw new HttpError(400, 'Falta el programa vendido');
        if (!montoTotal || montoTotal <= 0) throw new HttpError(400, 'Falta el monto total de la venta');
        if (pagoInicial === null || pagoInicial < 0) throw new HttpError(400, 'Falta cuánto pagó ahora');
        if (pagoInicial > montoTotal) throw new HttpError(400, 'El pago no puede ser mayor que el total');
      }
      let clienteId = null;
      const tz = await businessTz(); // antes de la transacción (no pedir otra conexión adentro)
      await tx(async (c) => {
        await c.query(
          `insert into ml_resultados (venta_id, resultado, programa, meses, monto_total, pago_inicial, metodo_pago, cuotas, motivo, closer_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (venta_id) do update set resultado = excluded.resultado, programa = excluded.programa, meses = excluded.meses,
             monto_total = excluded.monto_total, pago_inicial = excluded.pago_inicial, metodo_pago = excluded.metodo_pago,
             cuotas = excluded.cuotas, motivo = excluded.motivo, closer_id = excluded.closer_id, actualizado = now()`,
          [v.id, resultado, programa, meses, montoTotal, pagoInicial, text(b.metodoPago, 100), intOrNull(b.cuotas), motivo, v.closer_id || (esCloser ? user.id : null)],
        );
        // Mover la card según el resultado.
        const destino = { venta: 'ganado', cancelada: 'perdido', no_show: 'reagendar', pidio_reagendar: 'reagendar' }[resultado];
        const status = { venta: 'ganado', cancelada: 'cancelado' }[resultado] || (v.status === 'ganado' || v.status === 'cancelado' ? 'para_hoy' : v.status);
        const etapa = destino ? await stageOfType(c, destino) : null;
        if (etapa && etapa !== v.etapa_id) {
          const orden = await bottomOrder(c, etapa);
          await c.query('update ml_ventas set etapa_id = $2, orden = $3, status = $4, actualizado = now() where id = $1', [v.id, etapa, orden, status]);
        } else {
          await c.query('update ml_ventas set status = $2, actualizado = now() where id = $1', [v.id, status]);
        }
        // Venta → Cliente + pago inicial (una sola vez por agenda).
        if (resultado === 'venta') {
          const { rows: ex } = await c.query('select id from ml_clientes where venta_id = $1', [v.id]);
          if (ex[0]) {
            clienteId = ex[0].id;
            await c.query('update ml_clientes set programa = $2, meses = $3, ticket = $4, actualizado = now() where id = $1', [clienteId, programa, meses, montoTotal]);
          } else {
            const { rows: et } = await c.query("select id from ml_cliente_etapas order by (tipo = 'entrada') desc, orden limit 1");
            // Inicio = hoy en la zona del negocio; vence = inicio + meses (mismo número de día).
            const { rows: cl } = await c.query(
              `insert into ml_clientes (venta_id, nombre, telefono, email, instagram, contact_id, etapa_id, programa, meses, ticket, inicio, vence)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (now() at time zone $11)::date,
                       case when $9::int is null then null else ((now() at time zone $11)::date + make_interval(months => $9::int))::date end)
               returning id`,
              [v.id, v.nombre, v.telefono, v.email, v.instagram, v.contact_id, et[0]?.id || null, programa, meses, montoTotal, tz],
            );
            clienteId = cl[0].id;
            if (pagoInicial > 0) {
              await c.query(
                "insert into ml_pagos (cliente_id, monto, metodo, nota, user_id) values ($1, $2, $3, 'Pago inicial', $4)",
                [clienteId, pagoInicial, text(b.metodoPago, 100), user.id],
              );
            }
          }
        }
      });
      return { venta: out(await loadVenta(v.id)), clienteId };
    },
  },

  // ------------------------------------------------------------ etapas (columnas)
  {
    method: 'POST',
    path: '/etapas',
    auth: 'admin',
    handler: async ({ body }) => {
      const nombre = text((await body()).nombre, 80);
      if (!nombre) throw new HttpError(400, 'Falta el nombre');
      const [e] = await query('insert into ml_etapas (nombre, orden) values ($1, (select coalesce(max(orden), 0) + 1 from ml_etapas)) returning *', [nombre]);
      return { etapa: e };
    },
  },
  {
    method: 'PATCH',
    path: '/etapas/:id',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const id = requireUuid(params.id, 'columna');
      const b = await body();
      if (b.nombre !== undefined) {
        const nombre = text(b.nombre, 80);
        if (!nombre) throw new HttpError(400, 'Falta el nombre');
        await query('update ml_etapas set nombre = $2 where id = $1', [id, nombre]);
      }
      if (b.tipo !== undefined) {
        const tipo = ['entrada', 'ganado', 'perdido', 'reagendar', ''].includes(b.tipo) ? b.tipo : '';
        // Cada marca vive en una sola columna.
        if (tipo) await query("update ml_etapas set tipo = '' where tipo = $1", [tipo]);
        await query('update ml_etapas set tipo = $2 where id = $1', [id, tipo]);
      }
      return { etapas: await query('select id, nombre, orden, tipo from ml_etapas order by orden, nombre') };
    },
  },
  {
    method: 'DELETE',
    path: '/etapas/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'columna');
      const [{ n }] = await query('select count(*)::int as n from ml_ventas where etapa_id = $1', [id]);
      if (n > 0) throw new HttpError(409, `Esta columna tiene ${n} agenda(s): muévelas antes de borrarla.`);
      await query('delete from ml_etapas where id = $1', [id]);
      return { ok: true };
    },
  },
  {
    method: 'PUT',
    path: '/etapas/orden',
    auth: 'admin',
    handler: async ({ body }) => {
      const ids = (await body()).ids;
      if (!Array.isArray(ids)) throw new HttpError(400, 'Falta el orden');
      await tx(async (c) => {
        for (const [i, id] of ids.entries()) await c.query('update ml_etapas set orden = $2 where id = $1', [requireUuid(id), i + 1]);
      });
      return { ok: true };
    },
  },
];
