// Módulo Equipo: EOD (reporte de fin de día), preguntas del EOD, revisión del
// equipo y metas por persona. Usuarios y ajustes viven en core.js.
//
// Mismos criterios que la versión completa:
//  - Un EOD por persona y día (upsert). Las preguntas se desactivan, no se borran
//    (así la revisión sigue mostrando qué se preguntó ese día).
//  - Las 4 preguntas del setter (Outbound, Respuestas a Outbound, Inbound, Follow ups)
//    se reconocen por su TEXTO normalizado: si el admin las renombra, sus métricas
//    derivadas dejan de encontrarlas (quedan en «—»).
//  - Las métricas del CRM salen de api/_lib/metrics.js (no se repiten fórmulas acá).
import { query } from '../_lib/db.js';
import { HttpError } from '../_lib/http.js';
import { metrics, metricsByRole } from '../_lib/metrics.js';
import { businessTz, dateOrNull, dayRange, isAdmin, uuidOrNull } from '../_lib/util.js';

// ---------------------------------------------------------------- constantes
export const EOD_ROLES = ['setter', 'closer', 'coach'];
export const EOD_TYPES = ['numero', 'texto', 'sino'];
const HISTORY_DAYS = 21;
const MAX_TEXT = 2000;
const MAX_NUMBER = 10_000_000;

// Métricas con meta, por rol (la clave lleva el rol: una persona setter+closer
// tiene metas distintas de ventas/cash en cada rol).
export const META_METRICS = {
  setter: [
    { key: 'setter_calificadas', label: 'Agendas calificadas' },
    { key: 'setter_propuestas', label: 'Propuestas de llamada' },
    { key: 'setter_ventas', label: 'Ventas' },
    { key: 'setter_cash', label: 'Cash collected', money: true },
    { key: 'setter_outbound', label: 'Outbound (EOD)' },
  ],
  closer: [
    { key: 'closer_shows', label: 'Shows' },
    { key: 'closer_ventas', label: 'Ventas' },
    { key: 'closer_cash', label: 'Cash collected', money: true },
  ],
};
const META_KEYS = new Set(Object.values(META_METRICS).flat().map((m) => m.key));
const PERIODOS = ['semana', 'mes'];

// ---------------------------------------------------------------- preguntas por texto
/** Texto de pregunta normalizado: sin tildes, sin mayúsculas, guiones = espacios. */
export function normQ(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const KNOWN = {
  outbound: 'outbound',
  respuestasOutbound: 'respuestas a outbound',
  inbound: 'inbound',
  followUps: 'follow ups',
};
/** { outbound: Set(ids), ... } según el texto de cada pregunta (activas o no). */
function knownIds(preguntas) {
  const out = {};
  for (const [k, label] of Object.entries(KNOWN)) {
    out[k] = new Set(preguntas.filter((p) => normQ(p.texto) === label).map((p) => p.id));
  }
  return out;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Suma las 4 preguntas conocidas + cada pregunta numérica, por usuario. */
export function sumEod(envios, preguntas) {
  const ids = knownIds(preguntas);
  const numericas = new Set(preguntas.filter((p) => p.tipo === 'numero').map((p) => p.id));
  const byUser = new Map();
  for (const e of envios) {
    let s = byUser.get(e.user_id);
    if (!s) {
      s = { enviados: 0, outbound: null, respuestasOutbound: null, inbound: null, followUps: null, porPregunta: {} };
      byUser.set(e.user_id, s);
    }
    s.enviados += 1;
    for (const [qid, v] of Object.entries(e.respuestas || {})) {
      if (!isNum(v)) continue;
      for (const k of Object.keys(KNOWN)) if (ids[k].has(qid)) s[k] = (s[k] ?? 0) + v;
      if (numericas.has(qid)) s.porPregunta[qid] = (s.porPregunta[qid] ?? 0) + v;
    }
  }
  return byUser;
}

/** Métricas derivadas (mismas fórmulas que la pantalla «Mi EOD»). */
export function derivedEod(s, calificadas = null) {
  const outbound = s?.outbound ?? null;
  const resp = s?.respuestasOutbound ?? null;
  const inbound = s?.inbound ?? null;
  const nuevas = inbound === null && resp === null ? null : (inbound ?? 0) + (resp ?? 0);
  return {
    outbound,
    respuestasOutbound: resp,
    inbound,
    followUps: s?.followUps ?? null,
    pctRespuestaOutbound: outbound !== null && outbound > 0 && resp !== null ? (resp / outbound) * 100 : null,
    nuevasConversaciones: nuevas,
    pctConvCalificada: nuevas !== null && nuevas > 0 && calificadas !== null ? (calificadas / nuevas) * 100 : null,
  };
}

// ---------------------------------------------------------------- utilidades
function rolesOf(v) {
  return String(v || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

function cleanEodRoles(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((r) => String(r).trim())
    .filter((r) => EOD_ROLES.includes(r));
  return [...new Set(list)];
}

function preguntaOut(p) {
  return { id: p.id, texto: p.texto, tipo: p.tipo, roles: rolesOf(p.roles), orden: p.orden, activa: !!p.activa };
}

const PREGUNTA_COLS = 'id, texto, tipo, roles, orden, activa';

async function todayInTz() {
  const tz = await businessTz();
  const [r] = await query('select (now() at time zone $1)::date::text as d', [tz]);
  return r.d;
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function mondayOf(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(s, -((dow + 6) % 7));
}

function periodBounds(periodo, inicio) {
  if (periodo === 'semana') {
    const from = mondayOf(inicio);
    return { from, to: addDays(from, 6) };
  }
  const [y, m] = inicio.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to };
}

/** Fecha del EOD: 'YYYY-MM-DD', no futura y no más de un año atrás. */
async function eodDate(v, hoy) {
  const fecha = v === undefined || v === null || v === '' ? hoy : dateOrNull(v);
  if (!fecha) throw new HttpError(400, 'La fecha no es válida');
  if (fecha > hoy) throw new HttpError(400, 'No puedes cargar el EOD de un día que todavía no llega');
  if (fecha < addDays(hoy, -366)) throw new HttpError(400, 'Esa fecha es muy vieja (máximo un año atrás)');
  return fecha;
}

/** Preguntas activas que le tocan a estos roles. */
async function preguntasDe(roles) {
  const r = roles.filter((x) => EOD_ROLES.includes(x));
  if (!r.length) return [];
  return query(
    `select ${PREGUNTA_COLS} from ml_eod_preguntas
      where activa and string_to_array(roles, ',') && $1::text[]
      order by orden, creado`,
    [r],
  );
}

/** Limpia una respuesta según el tipo; undefined = sin responder. */
function cleanAnswer(tipo, v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (tipo === 'numero') {
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n)) throw new HttpError(400, 'Una respuesta de número no es un número válido');
    if (n < 0) throw new HttpError(400, 'Las respuestas de número no pueden ser negativas');
    if (n > MAX_NUMBER) throw new HttpError(400, 'Un número es demasiado grande');
    return n;
  }
  if (tipo === 'sino') {
    if (v === true || v === 'si' || v === 'sí' || v === 'yes') return true;
    if (v === false || v === 'no') return false;
    throw new HttpError(400, 'Una respuesta de sí/no no es válida');
  }
  const s = String(v).trim().slice(0, MAX_TEXT);
  return s || undefined;
}

async function historial(userId, hoy) {
  return query(
    `select fecha::text as fecha, creado, actualizado from ml_eod_envios
      where user_id = $1 and fecha >= $2::date and fecha <= $3::date
      order by fecha desc`,
    [userId, addDays(hoy, -HISTORY_DAYS), hoy],
  );
}

async function resumenDia(user, fecha) {
  const range = await dayRange({ from: fecha, to: fecha });
  const [setter, closer] = await Promise.all([
    user.roles.includes('setter') ? metrics(range, { setterId: user.id }) : null,
    user.roles.includes('closer') ? metrics(range, { closerId: user.id }) : null,
  ]);
  return { setter, closer };
}

// ---------------------------------------------------------------- rutas
export const routes = [
  // ------------------------------------------------------------ Mi EOD
  {
    method: 'GET',
    path: '/eod/mio',
    auth: EOD_ROLES,
    handler: async ({ user, query: q }) => {
      const hoy = await todayInTz();
      const fecha = await eodDate(q.fecha, hoy);
      const [preguntas, envio, hist, resumen] = await Promise.all([
        preguntasDe(user.roles),
        query('select respuestas, creado, actualizado from ml_eod_envios where user_id = $1 and fecha = $2::date', [user.id, fecha]),
        historial(user.id, hoy),
        resumenDia(user, fecha),
      ]);
      const e = envio[0] || null;
      return {
        fecha,
        hoy,
        preguntas: preguntas.map(preguntaOut),
        respuestas: e?.respuestas || {},
        envio: e ? { creado: e.creado, actualizado: e.actualizado } : null,
        historial: hist,
        resumen,
      };
    },
  },
  {
    method: 'GET',
    path: '/eod/mio/historial',
    auth: EOD_ROLES,
    handler: async ({ user }) => ({ historial: await historial(user.id, await todayInTz()) }),
  },
  {
    method: 'PUT',
    path: '/eod/mio',
    auth: EOD_ROLES,
    handler: async ({ user, body }) => {
      const b = await body();
      const hoy = await todayInTz();
      const fecha = await eodDate(b.fecha, hoy);
      const preguntas = await preguntasDe(user.roles);
      if (!preguntas.length) throw new HttpError(400, 'No hay preguntas del EOD para tu rol');
      const raw = b.respuestas && typeof b.respuestas === 'object' && !Array.isArray(b.respuestas) ? b.respuestas : {};
      const [prev] = await query('select respuestas from ml_eod_envios where user_id = $1 and fecha = $2::date', [user.id, fecha]);
      // Se conservan respuestas de preguntas que ya no están activas (historia).
      const merged = { ...(prev?.respuestas || {}) };
      let answered = 0;
      for (const p of preguntas) {
        const v = cleanAnswer(p.tipo, raw[p.id]);
        if (v === undefined) delete merged[p.id];
        else {
          merged[p.id] = v;
          answered += 1;
        }
      }
      if (!answered) throw new HttpError(400, 'Completa tus respuestas antes de cargar el EOD');
      const [row] = await query(
        `insert into ml_eod_envios (user_id, fecha, respuestas) values ($1, $2::date, $3::jsonb)
         on conflict (user_id, fecha) do update set respuestas = excluded.respuestas, actualizado = now()
         returning fecha::text as fecha, respuestas, creado, actualizado`,
        [user.id, fecha, JSON.stringify(merged)],
      );
      return {
        envio: { fecha: row.fecha, creado: row.creado, actualizado: row.actualizado },
        respuestas: row.respuestas,
        historial: await historial(user.id, hoy),
      };
    },
  },

  // ------------------------------------------------------------ preguntas (admin)
  {
    method: 'GET',
    path: '/eod/preguntas',
    auth: 'admin',
    handler: async () => ({
      preguntas: (await query(`select ${PREGUNTA_COLS} from ml_eod_preguntas order by orden, creado`)).map(preguntaOut),
    }),
  },
  {
    method: 'POST',
    path: '/eod/preguntas',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const texto = String(b.texto || '').trim().slice(0, 300);
      const tipo = EOD_TYPES.includes(b.tipo) ? b.tipo : null;
      const roles = cleanEodRoles(b.roles);
      if (!texto) throw new HttpError(400, 'Escribe la pregunta');
      if (!tipo) throw new HttpError(400, 'Elige el tipo de respuesta');
      if (!roles.length) throw new HttpError(400, 'Elige al menos un rol');
      const [p] = await query(
        `insert into ml_eod_preguntas (texto, tipo, roles, orden)
         values ($1, $2, $3, (select coalesce(max(orden), 0) + 1 from ml_eod_preguntas))
         returning ${PREGUNTA_COLS}`,
        [texto, tipo, roles.join(',')],
      );
      return { pregunta: preguntaOut(p) };
    },
  },
  {
    method: 'PUT',
    path: '/eod/preguntas/orden',
    auth: 'admin',
    handler: async ({ body }) => {
      const { ids } = await body();
      const list = Array.isArray(ids) ? ids.map(uuidOrNull) : [];
      const all = await query('select id from ml_eod_preguntas');
      const set = new Set(all.map((r) => r.id));
      if (list.length !== set.size || new Set(list).size !== list.length || list.some((id) => !set.has(id))) {
        throw new HttpError(400, 'El orden tiene que incluir todas las preguntas una sola vez');
      }
      await query(
        `update ml_eod_preguntas p set orden = x.i
           from unnest($1::uuid[]) with ordinality as x(id, i)
          where p.id = x.id`,
        [list],
      );
      return { preguntas: (await query(`select ${PREGUNTA_COLS} from ml_eod_preguntas order by orden, creado`)).map(preguntaOut) };
    },
  },
  {
    method: 'PATCH',
    path: '/eod/preguntas/:id',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const id = uuidOrNull(params.id);
      const [p] = id ? await query(`select ${PREGUNTA_COLS} from ml_eod_preguntas where id = $1`, [id]) : [];
      if (!p) throw new HttpError(404, 'No existe esa pregunta');
      const b = await body();
      const sets = [];
      const vals = [p.id];
      const add = (col, v) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (b.texto !== undefined) {
        const t = String(b.texto).trim().slice(0, 300);
        if (!t) throw new HttpError(400, 'Escribe la pregunta');
        add('texto', t);
      }
      if (b.tipo !== undefined) {
        if (!EOD_TYPES.includes(b.tipo)) throw new HttpError(400, 'Tipo de respuesta inválido');
        add('tipo', b.tipo);
      }
      if (b.roles !== undefined) {
        const r = cleanEodRoles(b.roles);
        if (!r.length) throw new HttpError(400, 'Elige al menos un rol');
        add('roles', r.join(','));
      }
      if (b.activa !== undefined) add('activa', !!b.activa);
      if (sets.length) await query(`update ml_eod_preguntas set ${sets.join(', ')} where id = $1`, vals);
      const [n] = await query(`select ${PREGUNTA_COLS} from ml_eod_preguntas where id = $1`, [p.id]);
      return { pregunta: preguntaOut(n) };
    },
  },

  // ------------------------------------------------------------ revisión del equipo (admin)
  {
    method: 'GET',
    path: '/eod/revision',
    auth: 'admin',
    handler: async ({ query: q }) => {
      const range = await dayRange(q);
      const userId = q.userId ? uuidOrNull(q.userId) : null;
      if (q.userId && !userId) throw new HttpError(400, 'Persona inválida');
      const [preguntas, envios, usuarios, setters, closers] = await Promise.all([
        query(`select ${PREGUNTA_COLS} from ml_eod_preguntas order by orden, creado`),
        query(
          `select e.id, e.user_id, e.fecha::text as fecha, e.respuestas, e.creado, e.actualizado,
                  u.nombre, u.email
             from ml_eod_envios e join ml_usuarios u on u.id = e.user_id
            where e.fecha >= $1::date and e.fecha <= $2::date
            order by e.fecha desc, u.nombre`,
          [range.fromDay, range.toDay],
        ),
        query(
          `select id, nombre, email, roles from ml_usuarios
            where activo and string_to_array(roles, ',') && $1::text[] order by nombre`,
          [EOD_ROLES],
        ),
        metricsByRole(range, 'setter'),
        metricsByRole(range, 'closer'),
      ]);
      const sums = sumEod(envios, preguntas);
      return {
        from: range.fromDay,
        to: range.toDay,
        preguntas: preguntas.map(preguntaOut),
        usuarios: usuarios.map((u) => ({ id: u.id, nombre: u.nombre, email: u.email, roles: rolesOf(u.roles) })),
        setters: setters.map((row) => {
          const { user: u, ...m } = row;
          const s = sums.get(u.id);
          return {
            user: { id: u.id, nombre: u.nombre, email: u.email },
            metrics: m,
            eod: { ...derivedEod(s, m.calificadas), enviados: s?.enviados ?? 0, porPregunta: s?.porPregunta ?? {} },
          };
        }),
        closers: closers.map(({ user: u, ...m }) => ({
          user: { id: u.id, nombre: u.nombre, email: u.email },
          metrics: m,
          enviados: sums.get(u.id)?.enviados ?? 0,
        })),
        envios: (userId ? envios.filter((e) => e.user_id === userId) : envios).slice(0, 500),
      };
    },
  },

  // ------------------------------------------------------------ metas
  {
    method: 'GET',
    path: '/metas',
    auth: ['setter', 'closer'],
    handler: async ({ user, query: q }) => {
      const periodo = PERIODOS.includes(q.periodo) ? q.periodo : 'semana';
      const base = dateOrNull(q.inicio) || (await todayInTz());
      const { from, to } = periodBounds(periodo, base);
      const range = await dayRange({ from, to });
      const admin = isAdmin(user);

      // Personas visibles: admin = todo el equipo activo; el resto, solo ella.
      const people = await query(
        `select id, nombre, email, roles from ml_usuarios
          where activo and string_to_array(roles, ',') && array['setter','closer']
            ${admin ? '' : 'and id = $1'}
          order by nombre`,
        admin ? [] : [user.id],
      );
      const ids = people.map((p) => p.id);
      const [metas, envios, preguntas] = await Promise.all([
        ids.length
          ? query(
              `select user_id, metrica, valor from ml_metas
                where periodo = $1 and inicio = $2::date and user_id = any($3::uuid[])`,
              [periodo, from, ids],
            )
          : [],
        ids.length
          ? query(
              `select user_id, respuestas from ml_eod_envios
                where fecha >= $1::date and fecha <= $2::date and user_id = any($3::uuid[])`,
              [from, to, ids],
            )
          : [],
        query(`select ${PREGUNTA_COLS} from ml_eod_preguntas`),
      ]);
      const metaOf = new Map(metas.map((m) => [`${m.user_id}:${m.metrica}`, Number(m.valor)]));
      const sums = sumEod(envios, preguntas);

      const filas = [];
      for (const p of people) {
        const roles = rolesOf(p.roles);
        for (const rol of ['setter', 'closer']) {
          if (!roles.includes(rol)) continue;
          const m = await metrics(range, rol === 'setter' ? { setterId: p.id } : { closerId: p.id });
          const actualOf = {
            setter_calificadas: m.calificadas,
            setter_propuestas: m.propuestas,
            setter_ventas: m.ventas,
            setter_cash: m.cash,
            setter_outbound: sums.get(p.id)?.outbound ?? 0,
            closer_shows: m.shows,
            closer_ventas: m.ventas,
            closer_cash: m.cash,
          };
          filas.push({
            user: { id: p.id, nombre: p.nombre, email: p.email },
            rol,
            metricas: META_METRICS[rol].map((def) => {
              const meta = metaOf.has(`${p.id}:${def.key}`) ? metaOf.get(`${p.id}:${def.key}`) : null;
              const actual = Number(actualOf[def.key] || 0);
              return {
                metrica: def.key,
                label: def.label,
                money: !!def.money,
                meta,
                actual,
                pct: meta && meta > 0 ? (actual / meta) * 100 : null,
              };
            }),
          });
        }
      }
      return { periodo, inicio: from, fin: to, puedeEditar: admin, filas };
    },
  },
  {
    method: 'PUT',
    path: '/metas',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const userId = uuidOrNull(b.userId);
      const metrica = String(b.metrica || '');
      const periodo = String(b.periodo || '');
      const base = dateOrNull(b.inicio);
      if (!userId) throw new HttpError(400, 'Falta la persona');
      if (!META_KEYS.has(metrica)) throw new HttpError(400, 'Métrica inválida');
      if (!PERIODOS.includes(periodo)) throw new HttpError(400, 'El período debe ser semana o mes');
      if (!base) throw new HttpError(400, 'Falta la fecha del período');
      const [u] = await query('select id, roles, activo from ml_usuarios where id = $1', [userId]);
      if (!u) throw new HttpError(404, 'No existe esa persona');
      const rol = metrica.split('_')[0];
      if (!rolesOf(u.roles).includes(rol)) throw new HttpError(400, `Esa persona no tiene el rol ${rol}`);
      const { from } = periodBounds(periodo, base);

      // Vacío = quitar la meta.
      if (b.valor === null || b.valor === undefined || b.valor === '') {
        await query('delete from ml_metas where user_id = $1 and metrica = $2 and periodo = $3 and inicio = $4::date', [
          userId,
          metrica,
          periodo,
          from,
        ]);
        return { meta: null };
      }
      const valor = Number(b.valor);
      if (!Number.isFinite(valor) || valor < 0 || valor > 1e9) throw new HttpError(400, 'La meta tiene que ser un número de 0 en adelante');
      const [row] = await query(
        `insert into ml_metas (user_id, metrica, periodo, inicio, valor) values ($1, $2, $3, $4::date, $5)
         on conflict (user_id, metrica, periodo, inicio) do update set valor = excluded.valor
         returning user_id, metrica, periodo, inicio::text as inicio, valor`,
        [userId, metrica, periodo, from, valor],
      );
      return { meta: { ...row, valor: Number(row.valor) } };
    },
  },
];
