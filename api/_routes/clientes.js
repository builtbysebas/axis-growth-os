// Clientes: tablero por etapas, pagos, renovaciones y notas.
// Los clientes nacen solos cuando una llamada se carga como «venta» (ver ventas.js);
// el admin también puede crearlos a mano.
// Permisos: admin todo; coach ve todos los clientes pero cambia solo los suyos (coach_id).
import { query, tx } from '../_lib/db.js';
import { HttpError, publicUser } from '../_lib/http.js';
import { assertStillActive, USER_COLS } from '../_lib/users.js';
import { businessTz, dateOrNull, intOrNull, isAdmin, numOrNull, out, requireUuid, text, uuidOrNull } from '../_lib/util.js';

export const METODOS = ['Transferencia', 'Mercado Pago', 'PayPal', 'Dlocal Go', 'Tarjeta', 'Efectivo', 'Otro'];
export const ETAPA_TIPOS = ['entrada', 'renovar', 'perdido', ''];
/** Días antes del vencimiento en que el cliente pasa solo a «Renovar». */
export const RENOVAR_DIAS = 20;

const TEXT_FIELDS = { nombre: 200, telefono: 60, email: 200, instagram: 100, contact_id: 100, programa: 200, notas: 5000 };

// Fila del cliente con lo pagado (sin renovaciones), saldo y renovaciones.
const CLIENTE_SELECT = `
  select c.id, c.venta_id, c.nombre, c.telefono, c.email, c.instagram, c.contact_id, c.etapa_id, c.coach_id,
         c.programa, c.meses, c.ticket, to_char(c.inicio, 'YYYY-MM-DD') as inicio, to_char(c.vence, 'YYYY-MM-DD') as vence,
         c.notas, c.orden, c.creado, c.actualizado,
         coalesce(p.pagado, 0) as pagado, coalesce(p.pagado_renov, 0) as pagado_renov,
         case when c.ticket is null then null else c.ticket - coalesce(p.pagado, 0) end as saldo,
         coalesce(r.n, 0)::int as renovaciones, r.ultima as ultima_renovacion
    from ml_clientes c
    left join lateral (
      select sum(monto) filter (where renovacion_id is null) as pagado,
             sum(monto) filter (where renovacion_id is not null) as pagado_renov
        from ml_pagos where cliente_id = c.id
    ) p on true
    left join lateral (select count(*) as n, max(creado) as ultima from ml_renovaciones where cliente_id = c.id) r on true`;

// ---------------------------------------------------------------- utilidades

/** 'YYYY-MM-DD' de hoy en la zona del negocio. */
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Fecha 'YYYY-MM-DD' real (no 2026-02-31) o null si viene vacía; 400 si viene mal. */
function dateField(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = dateOrNull(v);
  if (s) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1990 && y <= 2200) return s;
  }
  throw new HttpError(400, `La fecha de ${label} no es válida`);
}

function amountField(v, label, { required = false, positive = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new HttpError(400, `Falta ${label}`);
    return null;
  }
  const n = numOrNull(v);
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  if (n === null || n < 0 || n > 100_000_000) throw new HttpError(400, `${Label} no es válido`);
  if (positive && n <= 0) throw new HttpError(400, `${Label} tiene que ser mayor que 0`);
  return Math.round(n * 100) / 100;
}

function monthsField(v, { required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new HttpError(400, 'Faltan los meses del programa');
    return null;
  }
  const n = intOrNull(v);
  if (n === null || n < 1 || n > 120) throw new HttpError(400, 'Los meses tienen que ser un número entre 1 y 120');
  return n;
}

function metodoField(v, { required = false } = {}) {
  const m = text(v, 60);
  if (!m) {
    if (required) throw new HttpError(400, 'Elige el método de pago');
    return '';
  }
  if (!METODOS.includes(m)) throw new HttpError(400, 'Método de pago inválido');
  return m;
}

function canEdit(user, c) {
  return isAdmin(user) || (user.roles.includes('coach') && !!c.coach_id && c.coach_id === user.id);
}

async function loadRow(id, c = null) {
  const sql = `${CLIENTE_SELECT} where c.id = $1`;
  const rows = c ? (await c.query(sql, [id])).rows : await query(sql, [id]);
  return rows[0] || null;
}

async function loadCliente(id) {
  const row = await loadRow(requireUuid(id, 'cliente'));
  if (!row) throw new HttpError(404, 'No existe ese cliente');
  return row;
}

async function loadEditable(id, user) {
  const row = await loadCliente(id);
  if (!canEdit(user, row)) throw new HttpError(403, 'Este cliente es de otra coach: solo lo puede cambiar su coach o un admin.');
  return row;
}

/** Coach válido (usuario activo con rol coach) o null. */
async function validCoach(id) {
  if (!id) return null;
  const [u] = await query('select id, roles, activo from ml_usuarios where id = $1', [id]);
  if (!u || !u.activo || !String(u.roles).split(',').includes('coach')) throw new HttpError(400, 'Esa persona no es coach');
  return u.id;
}

/** Campos editables que llegan de la pantalla (solo los permitidos y validados). */
function cleanCliente(b = {}) {
  const o = {};
  for (const [f, max] of Object.entries(TEXT_FIELDS)) if (b[f] !== undefined) o[f] = text(b[f], max);
  if (o.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) throw new HttpError(400, 'El correo no es válido');
  if (b.coach_id !== undefined) o.coach_id = uuidOrNull(b.coach_id);
  if (b.meses !== undefined) o.meses = monthsField(b.meses);
  if (b.ticket !== undefined) o.ticket = amountField(b.ticket, 'el ticket');
  if (b.inicio !== undefined) o.inicio = dateField(b.inicio, 'inicio');
  if (b.vence !== undefined) o.vence = dateField(b.vence, 'vencimiento');
  return o;
}

async function bottomOrder(c, etapaId) {
  const { rows } = await c.query('select coalesce(max(orden), 0) + 1 as o from ml_clientes where etapa_id is not distinct from $1', [etapaId]);
  return rows[0].o;
}

/** Instante de un pago: hoy = ahora; otro día = mediodía de ese día en la zona del negocio. */
function paidAtSql(idx, tzIdx) {
  return `case when $${idx}::date is null then now() else (($${idx}::date + time '12:00') at time zone $${tzIdx}) end`;
}

/**
 * Pasa solo a la columna «Renovar» a quien vence en RENOVAR_DIAS días o menos (o ya venció),
 * una sola vez por fecha de vencimiento (renovar_para). Nunca toca la columna «Perdido».
 * Si alguien lo saca de «Renovar», se respeta hasta que cambie el vencimiento.
 */
export async function flipToRenovar(tz) {
  return query(
    `with r as (select id from ml_cliente_etapas where tipo = 'renovar' order by orden limit 1),
     cand as (
       select c.id, c.etapa_id, row_number() over (order by c.vence, c.creado) as rn
         from ml_clientes c
         left join ml_cliente_etapas e on e.id = c.etapa_id
        where c.vence is not null and c.vence <= $1::date + $2::int
          and c.renovar_para is distinct from c.vence
          and coalesce(e.tipo, '') <> 'perdido'
     ),
     base as (select coalesce(max(orden), 0) as m from ml_clientes where etapa_id = (select id from r))
     update ml_clientes c
        set etapa_id = r.id,
            orden = case when cand.etapa_id is not distinct from r.id then c.orden else base.m + cand.rn end,
            renovar_para = c.vence,
            actualizado = now()
       from cand, r, base
      where c.id = cand.id
     returning c.id`,
    [todayIn(tz), RENOVAR_DIAS],
  );
}

const ETAPAS_SQL = 'select id, nombre, orden, tipo from ml_cliente_etapas order by orden, nombre';

// ---------------------------------------------------------------- rutas
export const routes = [
  // ------------------------------------------------------------ lectura
  {
    method: 'GET',
    path: '/clientes',
    auth: ['coach'],
    handler: async ({ user }) => {
      const tz = await businessTz();
      await flipToRenovar(tz);
      const [etapas, clientes, usuarios] = await Promise.all([
        query(ETAPAS_SQL),
        query(`${CLIENTE_SELECT} order by c.orden, c.creado`),
        query(`select ${USER_COLS} from ml_usuarios order by nombre`),
      ]);
      assertStillActive(user, usuarios);
      const activos = usuarios.map(publicUser).filter((u) => u.activo);
      return {
        etapas,
        clientes: clientes.map(out),
        coaches: activos.filter((u) => u.roles.includes('coach')),
        usuarios: activos.map((u) => ({ id: u.id, nombre: u.nombre, email: u.email, roles: u.roles })),
        metodos: METODOS,
        hoy: todayIn(tz),
        renovarDias: RENOVAR_DIAS,
      };
    },
  },
  {
    method: 'GET',
    path: '/clientes/:id',
    auth: ['coach'],
    handler: async ({ params, user }) => {
      const cl = await loadCliente(params.id);
      const tz = await businessTz();
      const [pagos, renovaciones, notas, venta] = await Promise.all([
        query(
          `select p.id, p.monto, p.pagado, to_char((p.pagado at time zone $2)::date, 'YYYY-MM-DD') as fecha, p.metodo, p.nota,
                  p.renovacion_id, r.programa as renovacion_programa, u.nombre as autor
             from ml_pagos p
             left join ml_renovaciones r on r.id = p.renovacion_id
             left join ml_usuarios u on u.id = p.user_id
            where p.cliente_id = $1 order by p.pagado desc, p.creado desc`,
          [cl.id, tz],
        ),
        query(
          `select r.id, r.programa, r.meses, r.monto_total, to_char(r.inicio, 'YYYY-MM-DD') as inicio, to_char(r.vence, 'YYYY-MM-DD') as vence,
                  to_char((r.creado at time zone $2)::date, 'YYYY-MM-DD') as fecha, r.creado, u.nombre as autor,
                  coalesce((select sum(monto) from ml_pagos where renovacion_id = r.id), 0) as pagado
             from ml_renovaciones r left join ml_usuarios u on u.id = r.user_id
            where r.cliente_id = $1 order by r.creado desc`,
          [cl.id, tz],
        ),
        query(
          `select n.id, n.texto, n.creado, u.nombre as autor from ml_cliente_notas n
             left join ml_usuarios u on u.id = n.user_id where n.cliente_id = $1 order by n.creado desc`,
          [cl.id],
        ),
        cl.venta_id
          ? query(
              `select to_char((v.agendada at time zone $2)::date, 'YYYY-MM-DD') as agendada, s.nombre as setter, k.nombre as closer
                 from ml_ventas v left join ml_usuarios s on s.id = v.setter_id left join ml_usuarios k on k.id = v.closer_id
                where v.id = $1`,
              [cl.venta_id, tz],
            )
          : [],
      ]);
      return {
        cliente: out(cl),
        pagos: pagos.map(out),
        renovaciones: renovaciones.map(out),
        notas,
        venta: venta[0] ? out(venta[0]) : null,
        puedeEditar: canEdit(user, cl),
      };
    },
  },

  // ------------------------------------------------------------ crear / editar / borrar
  {
    method: 'POST',
    path: '/clientes',
    auth: 'admin',
    handler: async ({ body, user }) => {
      const b = await body();
      const row = cleanCliente(b);
      if (!row.nombre) throw new HttpError(400, 'Falta el nombre');
      row.coach_id = await validCoach(row.coach_id || null);
      const pagoInicial = amountField(b.pagoInicial, 'el pago inicial');
      const metodo = metodoField(b.metodo, { required: !!pagoInicial });
      if (pagoInicial && row.ticket !== null && row.ticket !== undefined && pagoInicial > row.ticket) {
        throw new HttpError(400, 'El pago inicial no puede ser mayor que el ticket');
      }
      const tz = await businessTz();
      const hoy = todayIn(tz);
      if (!row.inicio) row.inicio = hoy;
      const id = await tx(async (c) => {
        const { rows: et } = await c.query("select id from ml_cliente_etapas order by (tipo = 'entrada') desc, orden limit 1");
        const etapaId = et[0]?.id || null;
        const orden = await bottomOrder(c, etapaId);
        const cols = Object.keys(row);
        const vals = Object.values(row);
        const { rows } = await c.query(
          `insert into ml_clientes (etapa_id, orden${cols.map((k) => `, ${k}`).join('')})
           values ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) returning id`,
          [etapaId, orden, ...vals],
        );
        const newId = rows[0].id;
        // Vence automático = inicio + meses (si no se puso a mano).
        if (!row.vence && row.meses) {
          await c.query("update ml_clientes set vence = (inicio + make_interval(months => meses))::date where id = $1", [newId]);
        }
        if (pagoInicial) {
          await c.query("insert into ml_pagos (cliente_id, monto, metodo, nota, user_id) values ($1, $2, $3, 'Pago inicial', $4)", [
            newId,
            pagoInicial,
            metodo,
            user.id,
          ]);
        }
        return newId;
      });
      return { cliente: out(await loadRow(id)) };
    },
  },
  {
    method: 'PATCH',
    path: '/clientes/:id',
    auth: ['coach'],
    handler: async ({ params, body, user }) => {
      const before = await loadEditable(params.id, user);
      const patch = cleanCliente(await body());
      if ('nombre' in patch && !patch.nombre) throw new HttpError(400, 'Falta el nombre');
      if ('coach_id' in patch) {
        if (patch.coach_id === (before.coach_id || null)) delete patch.coach_id;
        else if (!isAdmin(user)) throw new HttpError(403, 'Solo un admin puede cambiar la coach de un cliente.');
        else patch.coach_id = await validCoach(patch.coach_id);
      }
      const cols = Object.keys(patch);
      if (cols.length) {
        const sets = cols.map((c, i) => `${c} = $${i + 2}`).concat('actualizado = now()');
        await query(`update ml_clientes set ${sets.join(', ')} where id = $1`, [before.id, ...cols.map((c) => patch[c])]);
      }
      return { cliente: out(await loadRow(before.id)) };
    },
  },
  {
    method: 'DELETE',
    path: '/clientes/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'cliente');
      await query('delete from ml_clientes where id = $1', [id]);
      return { ok: true };
    },
  },
  {
    // Mover de columna / reordenar. beforeId = el cliente que queda debajo (null = al final).
    method: 'POST',
    path: '/clientes/:id/mover',
    auth: ['coach'],
    handler: async ({ params, body, user }) => {
      const cl = await loadEditable(params.id, user);
      const b = await body();
      const etapaId = requireUuid(b.etapaId, 'columna');
      let beforeId = uuidOrNull(b.beforeId);
      if (beforeId === cl.id) beforeId = null;
      await tx(async (c) => {
        const { rows: et } = await c.query('select id from ml_cliente_etapas where id = $1', [etapaId]);
        if (!et[0]) throw new HttpError(404, 'No existe esa columna');
        let orden;
        if (beforeId) {
          const { rows } = await c.query(
            `select b.orden, (select max(orden) from ml_clientes where etapa_id = $1 and orden < b.orden and id <> $3) as prev
               from ml_clientes b where b.id = $2 and b.etapa_id = $1`,
            [etapaId, beforeId, cl.id],
          );
          if (rows[0]) orden = rows[0].prev == null ? rows[0].orden - 1 : (rows[0].prev + rows[0].orden) / 2;
        }
        if (orden === undefined) orden = await bottomOrder(c, etapaId);
        await c.query('update ml_clientes set etapa_id = $2, orden = $3, actualizado = now() where id = $1', [cl.id, etapaId, orden]);
      });
      return { cliente: out(await loadRow(cl.id)) };
    },
  },

  // ------------------------------------------------------------ pagos
  {
    method: 'POST',
    path: '/clientes/:id/pagos',
    auth: ['coach'],
    handler: async ({ params, body, user }) => {
      const cl = await loadEditable(params.id, user);
      const b = await body();
      const monto = amountField(b.monto, 'el monto', { required: true, positive: true });
      const metodo = metodoField(b.metodo, { required: true });
      const nota = text(b.nota, 300);
      const tz = await businessTz();
      const hoy = todayIn(tz);
      let fecha = dateField(b.fecha, 'pago');
      if (fecha && fecha > hoy) throw new HttpError(400, 'La fecha del pago no puede ser futura');
      if (fecha === hoy) fecha = null;
      const renovacionId = uuidOrNull(b.renovacionId);
      if (b.renovacionId && !renovacionId) throw new HttpError(404, 'No existe esa renovación');
      if (renovacionId) {
        const [r] = await query('select id from ml_renovaciones where id = $1 and cliente_id = $2', [renovacionId, cl.id]);
        if (!r) throw new HttpError(404, 'No existe esa renovación');
      }
      const [p] = await query(
        `insert into ml_pagos (cliente_id, renovacion_id, monto, pagado, metodo, nota, user_id)
         values ($1, $2, $3, ${paidAtSql(4, 5)}, $6, $7, $8) returning id`,
        [cl.id, renovacionId, monto, fecha, tz, metodo, nota, user.id],
      );
      return { pagoId: p.id, cliente: out(await loadRow(cl.id)) };
    },
  },
  {
    method: 'PATCH',
    path: '/cliente-pagos/:id',
    auth: ['coach'],
    handler: async ({ params, body, user }) => {
      const id = requireUuid(params.id, 'pago');
      const [p] = await query('select p.id, p.cliente_id, c.coach_id from ml_pagos p join ml_clientes c on c.id = p.cliente_id where p.id = $1', [id]);
      if (!p) throw new HttpError(404, 'No existe ese pago');
      if (!canEdit(user, p)) throw new HttpError(403, 'Este cliente es de otra coach: solo lo puede cambiar su coach o un admin.');
      const b = await body();
      const tz = await businessTz();
      if (b.fecha !== undefined) {
        const fecha = dateField(b.fecha, 'pago');
        if (!fecha) throw new HttpError(400, 'Elige la fecha del pago');
        if (fecha > todayIn(tz)) throw new HttpError(400, 'La fecha del pago no puede ser futura');
        // Mismo día que ya tenía = no se toca (conserva la hora real).
        await query(
          `update ml_pagos set pagado = (($2::date + time '12:00') at time zone $3)
            where id = $1 and (pagado at time zone $3)::date <> $2::date`,
          [id, fecha, tz],
        );
      }
      if (b.metodo !== undefined) await query('update ml_pagos set metodo = $2 where id = $1', [id, metodoField(b.metodo)]);
      if (b.nota !== undefined) await query('update ml_pagos set nota = $2 where id = $1', [id, text(b.nota, 300)]);
      return { cliente: out(await loadRow(p.cliente_id)) };
    },
  },
  {
    method: 'DELETE',
    path: '/cliente-pagos/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'pago');
      const [p] = await query('delete from ml_pagos where id = $1 returning cliente_id', [id]);
      if (!p) throw new HttpError(404, 'No existe ese pago');
      return { cliente: out(await loadRow(p.cliente_id)) };
    },
  },

  // ------------------------------------------------------------ renovaciones
  {
    method: 'POST',
    path: '/clientes/:id/renovaciones',
    auth: ['coach'],
    handler: async ({ params, body, user }) => {
      const cl = await loadEditable(params.id, user);
      const b = await body();
      const programa = text(b.programa, 200);
      if (!programa) throw new HttpError(400, 'Falta el programa');
      const meses = monthsField(b.meses, { required: true });
      const montoTotal = amountField(b.montoTotal, 'el monto total', { required: true, positive: true });
      const pagoInicial = amountField(b.pagoInicial, 'el pago inicial');
      if (pagoInicial && pagoInicial > montoTotal) throw new HttpError(400, 'El pago no puede ser mayor que el total');
      const metodo = metodoField(b.metodo, { required: !!pagoInicial });
      const tz = await businessTz();
      const hoy = todayIn(tz);
      let fecha = dateField(b.fecha, 'renovación') || hoy;
      if (fecha > hoy) throw new HttpError(400, 'La fecha de la renovación no puede ser futura');
      const fechaSql = fecha === hoy ? null : fecha;
      const renovacionId = await tx(async (c) => {
        // Sigue desde el vencimiento actual si todavía está vigente; si no, desde la fecha de la renovación.
        const { rows: per } = await c.query(
          `select to_char(base, 'YYYY-MM-DD') as inicio, to_char((base + make_interval(months => $3))::date, 'YYYY-MM-DD') as vence
             from (select case when c.vence is not null and c.vence > $2::date then c.vence else $2::date end as base
                     from ml_clientes c where c.id = $1) x`,
          [cl.id, fecha, meses],
        );
        const { inicio, vence } = per[0];
        const { rows } = await c.query(
          `insert into ml_renovaciones (cliente_id, programa, meses, monto_total, inicio, vence, user_id, creado)
           values ($1, $2, $3, $4, $5, $6, $7, ${paidAtSql(8, 9)}) returning id`,
          [cl.id, programa, meses, montoTotal, inicio, vence, user.id, fechaSql, tz],
        );
        const rid = rows[0].id;
        if (pagoInicial) {
          await c.query(
            `insert into ml_pagos (cliente_id, renovacion_id, monto, pagado, metodo, nota, user_id)
             values ($1, $2, $3, ${paidAtSql(4, 5)}, $6, 'Pago de renovación', $7)`,
            [cl.id, rid, pagoInicial, fechaSql, tz, metodo, user.id],
          );
        }
        await c.query('update ml_clientes set programa = $2, meses = $3, vence = $4, actualizado = now() where id = $1', [
          cl.id,
          programa,
          meses,
          vence,
        ]);
        return rid;
      });
      return { renovacionId, cliente: out(await loadRow(cl.id)) };
    },
  },

  // ------------------------------------------------------------ notas
  {
    method: 'POST',
    path: '/clientes/:id/notas',
    auth: ['coach'],
    handler: async ({ params, body, user }) => {
      const cl = await loadEditable(params.id, user);
      const t = text((await body()).texto, 5000);
      if (!t) throw new HttpError(400, 'Escribe la nota');
      const [n] = await query('insert into ml_cliente_notas (cliente_id, user_id, texto) values ($1, $2, $3) returning id, texto, creado', [
        cl.id,
        user.id,
        t,
      ]);
      return { nota: { ...n, autor: user.nombre } };
    },
  },

  // ------------------------------------------------------------ columnas (solo admin)
  {
    method: 'POST',
    path: '/cliente-etapas',
    auth: 'admin',
    handler: async ({ body }) => {
      const nombre = text((await body()).nombre, 80);
      if (!nombre) throw new HttpError(400, 'Falta el nombre');
      await query('insert into ml_cliente_etapas (nombre, orden) values ($1, (select coalesce(max(orden), 0) + 1 from ml_cliente_etapas))', [nombre]);
      return { etapas: await query(ETAPAS_SQL) };
    },
  },
  {
    method: 'PUT',
    path: '/cliente-etapas/orden',
    auth: 'admin',
    handler: async ({ body }) => {
      const ids = (await body()).ids;
      if (!Array.isArray(ids) || ids.length > 100) throw new HttpError(400, 'Falta el orden');
      const clean = ids.map((id) => requireUuid(id, 'columna'));
      await tx(async (c) => {
        for (const [i, id] of clean.entries()) await c.query('update ml_cliente_etapas set orden = $2 where id = $1', [id, i + 1]);
      });
      return { etapas: await query(ETAPAS_SQL) };
    },
  },
  {
    method: 'PATCH',
    path: '/cliente-etapas/:id',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const id = requireUuid(params.id, 'columna');
      const [e] = await query('select id from ml_cliente_etapas where id = $1', [id]);
      if (!e) throw new HttpError(404, 'No existe esa columna');
      const b = await body();
      if (b.nombre !== undefined) {
        const nombre = text(b.nombre, 80);
        if (!nombre) throw new HttpError(400, 'Falta el nombre');
        await query('update ml_cliente_etapas set nombre = $2 where id = $1', [id, nombre]);
      }
      if (b.tipo !== undefined) {
        if (!ETAPA_TIPOS.includes(b.tipo)) throw new HttpError(400, 'Marca inválida');
        await tx(async (c) => {
          // Cada marca vive en una sola columna.
          if (b.tipo) await c.query("update ml_cliente_etapas set tipo = '' where tipo = $1 and id <> $2", [b.tipo, id]);
          await c.query('update ml_cliente_etapas set tipo = $2 where id = $1', [id, b.tipo]);
        });
      }
      return { etapas: await query(ETAPAS_SQL) };
    },
  },
  {
    method: 'DELETE',
    path: '/cliente-etapas/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'columna');
      const [{ n }] = await query('select count(*)::int as n from ml_clientes where etapa_id = $1', [id]);
      if (n > 0) throw new HttpError(409, `Esta columna tiene ${n} cliente(s): muévelos antes de borrarla.`);
      const [{ total }] = await query('select count(*)::int as total from ml_cliente_etapas');
      if (total <= 1) throw new HttpError(409, 'Tiene que quedar al menos una columna.');
      await query('delete from ml_cliente_etapas where id = $1', [id]);
      return { etapas: await query(ETAPAS_SQL) };
    },
  },
];
