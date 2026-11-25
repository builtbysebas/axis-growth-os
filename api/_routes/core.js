// Núcleo: estado, primer admin, sesión, ajustes y avisos de ManyChat.
import crypto from 'node:crypto';
import { dbEnvNames, dbUrl, derivedSecret, ensureReady, query, tx } from '../_lib/db.js';
import { checkPassword, clearSession, hashPassword, HttpError, publicUser, setSession } from '../_lib/http.js';
import { findUserByEmail, USER_COLS } from '../_lib/users.js';
import { clearTzCache } from '../_lib/util.js';

function validZone(z) {
  if (!z || typeof z !== 'string' || z.length > 64) return false;
  try {
    new Intl.DateTimeFormat('es', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

const EVENT_TYPES = ['content_reply', 'call_proposed', 'link_sent'];

/** null (quitar) o el id de un contenido que existe; si no existe, 404. */
async function validContenido(v) {
  if (v === null || v === undefined || v === '') return null;
  const [c] = await query('select id from ml_contenido where id::text = $1', [String(v)]);
  if (!c) throw new HttpError(404, 'No existe ese contenido');
  return c.id;
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const ROLES = ['admin', 'setter', 'closer', 'coach'];
function cleanRoles(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((r) => String(r).trim())
    .filter((r) => ROLES.includes(r));
  return [...new Set(list)].join(',');
}

export const routes = [
  // ------------------------------------------------------------ usuarios (admin)
  {
    method: 'GET',
    path: '/usuarios',
    auth: 'admin',
    handler: async () => ({
      usuarios: (await query(`select ${USER_COLS} from ml_usuarios order by activo desc, nombre`)).map(publicUser),
    }),
  },
  {
    method: 'POST',
    path: '/usuarios',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const nombre = String(b.nombre || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const roles = cleanRoles(b.roles);
      if (!nombre || !email) throw new HttpError(400, 'Falta nombre o correo');
      if (!roles) throw new HttpError(400, 'Elige al menos un rol');
      if (String(b.password || '').length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
      const [dup] = await query('select id from ml_usuarios where email = $1', [email]);
      if (dup) throw new HttpError(409, 'Ya existe un usuario con ese correo');
      const [u] = await query(
        `insert into ml_usuarios (nombre, email, roles, password) values ($1, $2, $3, $4) returning ${USER_COLS}`,
        [nombre, email, roles, hashPassword(String(b.password))],
      );
      return { usuario: publicUser(u) };
    },
  },
  {
    method: 'PATCH',
    path: '/usuarios/:id',
    auth: 'admin',
    handler: async ({ params, body, user }) => {
      const b = await body();
      const [u] = await query(`select ${USER_COLS} from ml_usuarios where id::text = $1`, [String(params.id)]);
      if (!u) throw new HttpError(404, 'No existe ese usuario');
      const sets = [];
      const vals = [u.id];
      const add = (col, v) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (b.nombre !== undefined) {
        const n = String(b.nombre).trim();
        if (!n) throw new HttpError(400, 'Falta el nombre');
        add('nombre', n);
      }
      if (b.email !== undefined) {
        const e = String(b.email).trim().toLowerCase();
        if (!e) throw new HttpError(400, 'Falta el correo');
        add('email', e);
      }
      if (b.roles !== undefined) {
        const r = cleanRoles(b.roles);
        if (!r) throw new HttpError(400, 'Elige al menos un rol');
        if (u.id === user.id && !r.split(',').includes('admin')) throw new HttpError(400, 'No te puedes quitar el rol de admin a ti misma');
        add('roles', r);
      }
      if (b.activo !== undefined) {
        if (u.id === user.id && !b.activo) throw new HttpError(400, 'No te puedes desactivar a ti misma');
        add('activo', !!b.activo);
      }
      if (b.password !== undefined) {
        if (String(b.password).length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
        add('password', hashPassword(String(b.password)));
      }
      if (sets.length) await query(`update ml_usuarios set ${sets.join(', ')} where id = $1`, vals);
      const [n] = await query(`select ${USER_COLS} from ml_usuarios where id = $1`, [u.id]);
      return { usuario: publicUser(n) };
    },
  },
  {
    method: 'GET',
    path: '/ajustes',
    auth: 'user',
    handler: async () => {
      const rows = await query("select key, value from ml_settings where key in ('zona', 'negocio', 'meta_cash')");
      const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return { zona: m.zona || 'America/Lima', negocio: m.negocio || '', metaCash: Number(m.meta_cash || 10000) };
    },
  },
  {
    method: 'PATCH',
    path: '/ajustes',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const set = async (k, v) =>
        query('insert into ml_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, v]);
      if (b.zona !== undefined) {
        const z = String(b.zona).trim();
        try {
          new Intl.DateTimeFormat('es', { timeZone: z });
        } catch {
          throw new HttpError(400, 'Zona horaria inválida (ej. America/Lima)');
        }
        await set('zona', z);
        clearTzCache();
      }
      if (b.negocio !== undefined) await set('negocio', String(b.negocio).trim().slice(0, 80) || 'Mi negocio');
      if (b.metaCash !== undefined) {
        const n = Number(b.metaCash);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Meta inválida');
        await set('meta_cash', String(n));
      }
      return { ok: true };
    },
  },
  {
    method: 'GET',
    path: '/status',
    auth: 'public',
    db: false,
    handler: async () => {
      if (!dbUrl()) {
        const names = dbEnvNames();
        return {
          connected: false,
          needsAdmin: false,
          reason:
            'Falta conectar la base de datos: en Vercel, Storage → Neon (o Supabase) → Connect, y después Redeploy.' +
            (names.length ? ` (Variables encontradas: ${names.join(', ')})` : ''),
        };
      }
      try {
        await ensureReady();
        const [{ n }] = await query('select count(*)::int as n from ml_usuarios');
        return { connected: true, needsAdmin: n === 0 };
      } catch (err) {
        return { connected: false, needsAdmin: false, reason: err.message };
      }
    },
  },
  {
    method: 'POST',
    path: '/setup',
    auth: 'public',
    handler: async ({ body, res }) => {
      const { nombre, email, password, negocio, zona } = await body();
      if (!nombre || !email || !password) throw new HttpError(400, 'Completa nombre, correo y contraseña');
      if (String(password).length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
      const u = await tx(async (c) => {
        await c.query('select pg_advisory_xact_lock(726345002)');
        const { rows } = await c.query('select count(*)::int as n from ml_usuarios');
        if (rows[0].n > 0) throw new HttpError(409, 'Ya existe un administrador. Inicia sesión.');
        const ins = await c.query(
          `insert into ml_usuarios (nombre, email, roles, password) values ($1, $2, 'admin', $3) returning ${USER_COLS}`,
          [String(nombre).trim(), String(email).trim().toLowerCase(), hashPassword(String(password))],
        );
        // Datos del negocio del primer arranque (se cambian después en Ajustes).
        const neg = String(negocio || '').trim().slice(0, 80);
        if (neg) await c.query(`insert into ml_settings (key, value) values ('negocio', $1) on conflict (key) do update set value = excluded.value`, [neg]);
        if (validZone(zona)) await c.query(`insert into ml_settings (key, value) values ('zona', $1) on conflict (key) do update set value = excluded.value`, [String(zona)]);
        return ins.rows[0];
      });
      clearTzCache();
      setSession(res, u);
      return { user: publicUser(u) };
    },
  },
  {
    method: 'POST',
    path: '/auth/login',
    auth: 'public',
    handler: async ({ body, res, req }) => {
      const { email, password, remember } = await body();
      const mail = String(email || '').trim().toLowerCase().slice(0, 300);
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 100);
      // Máx. 5 intentos fallidos por correo (o 20 por IP) cada 15 minutos.
      const [f] = await query(
        `select count(*) filter (where email = $1)::int as por_email, count(*) filter (where ip = $2 and $2 <> '')::int as por_ip
           from ml_login_fallos where creado > now() - interval '15 minutes'`,
        [mail, ip],
      );
      if (f.por_email >= 5 || f.por_ip >= 20) throw new HttpError(429, 'Demasiados intentos. Espera 15 minutos y vuelve a probar.');
      const u = await findUserByEmail(mail);
      if (!u || !u.activo || !checkPassword(String(password || ''), u.password)) {
        await query('insert into ml_login_fallos (email, ip) values ($1, $2)', [mail, ip]);
        await query("delete from ml_login_fallos where creado < now() - interval '1 day'");
        await new Promise((r) => setTimeout(r, 600));
        throw new HttpError(401, 'Correo o contraseña incorrectos');
      }
      await query('delete from ml_login_fallos where email = $1', [mail]);
      setSession(res, u, { remember: !!remember });
      return { user: publicUser(u) };
    },
  },
  {
    method: 'POST',
    path: '/auth/logout',
    auth: 'public',
    handler: async ({ res }) => {
      clearSession(res);
      return { ok: true };
    },
  },
  { method: 'GET', path: '/auth/me', auth: 'user', handler: async ({ user }) => ({ user }) },
  {
    method: 'POST',
    path: '/auth/password',
    auth: 'user',
    handler: async ({ body, user }) => {
      const { actual, nueva } = await body();
      if (!nueva || String(nueva).length < 8) throw new HttpError(400, 'La contraseña nueva debe tener al menos 8 caracteres');
      const [u] = await query('select password from ml_usuarios where id = $1', [user.id]);
      if (!u || !checkPassword(String(actual || ''), u.password)) throw new HttpError(400, 'La contraseña actual no es correcta');
      await query('update ml_usuarios set password = $2 where id = $1', [user.id, hashPassword(String(nueva))]);
      return { ok: true };
    },
  },
  {
    method: 'GET',
    path: '/settings',
    auth: 'admin',
    handler: async ({ req }) => {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      return {
        manychatUrl: `${proto}://${host}/api/webhooks/manychat`,
        manychatSecret: derivedSecret('manychat'),
      };
    },
  },
  {
    method: 'POST',
    path: '/webhooks/manychat',
    auth: 'public',
    handler: async ({ req, body }) => {
      if (!sameSecret(req.headers['x-webhook-secret'], derivedSecret('manychat'))) throw new HttpError(401, 'no autorizado');
      const b = await body();
      if (!EVENT_TYPES.includes(b.eventType)) throw new HttpError(400, `eventType debe ser uno de: ${EVENT_TYPES.join(', ')}`);
      if (!b.contactId) throw new HttpError(400, 'Falta contactId');
      const codigo = String(b.contentCode || '').trim().slice(0, 300);
      const setterEmail = String(b.setterEmail || '').trim().toLowerCase().slice(0, 300);
      // El código se compara sin mayúsculas ni espacios de más; si no matchea queda
      // guardado igual (cola «Sin match»): nunca se pierde un lead.
      const [cont] = codigo
        ? await query(`select id from ml_contenido where lower(regexp_replace(codigo, '\\s+', ' ', 'g')) = lower(regexp_replace($1, '\\s+', ' ', 'g')) limit 1`, [codigo])
        : [];
      const [setter] = setterEmail ? await query('select id from ml_usuarios where email = $1', [setterEmail]) : [];
      const raw = JSON.stringify(b);
      await query(
        `insert into ml_eventos (tipo, contact_id, codigo, setter_email, usuario_ig, nombre, datos, contenido_id, setter_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          b.eventType,
          String(b.contactId).slice(0, 200),
          codigo,
          setterEmail,
          String(b.leadUsername || '').replace(/^@/, '').toLowerCase().slice(0, 200),
          String(b.leadName || '').slice(0, 300),
          raw.length <= 20000 ? raw : null,
          cont?.id || null,
          setter?.id || null,
        ],
      );
      return { ok: true, matched: !!cont };
    },
  },
  {
    // Nueva agenda desde afuera (ManyChat, Zapier, n8n, formulario propio o Calendly).
    // Clave: header x-webhook-secret o ?k= (para herramientas que no permiten headers).
    // Formato simple: { nombre, telefono, email, instagram, contactId, fechaLlamada,
    //   setterEmail, closerEmail, presupuesto: 'con'|'sin', origen, ref }.
    // También acepta el aviso «invitee.created» de Calendly tal cual llega.
    method: 'POST',
    path: '/webhooks/agenda',
    auth: 'public',
    handler: async ({ req, body, query: q }) => {
      const given = req.headers['x-webhook-secret'] || q.k || '';
      if (!sameSecret(given, derivedSecret('manychat'))) throw new HttpError(401, 'no autorizado');
      const b = await body();
      const cal = b && b.payload && (b.event === 'invitee.created' || b.payload.scheduled_event) ? b.payload : null;
      const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
      const answers = cal?.questions_and_answers || [];
      const answer = (re) => answers.find((a) => re.test(String(a.question || '')))?.answer;
      const nombre = String(pick(b.nombre, cal?.name, [cal?.first_name, cal?.last_name].filter(Boolean).join(' ')) || '').trim().slice(0, 200);
      if (!nombre) throw new HttpError(400, 'Falta el nombre');
      const telefono = String(pick(b.telefono, cal?.text_reminder_number, answer(/tel[eé]fono|celular|whats/i)) || '').trim().slice(0, 60);
      const email = String(pick(b.email, cal?.email) || '').trim().toLowerCase().slice(0, 200);
      const instagram = String(pick(b.instagram, answer(/instagram/i)) || '').trim().replace(/^@/, '').slice(0, 100);
      const contactId = String(pick(b.contactId, b.contact_id, cal?.tracking?.utm_content) || '').trim().slice(0, 200);
      const fechaRaw = pick(b.fechaLlamada, b.fecha_llamada, cal?.scheduled_event?.start_time);
      const fecha = fechaRaw && !Number.isNaN(new Date(fechaRaw).getTime()) ? new Date(fechaRaw).toISOString() : null;
      const setterEmail = String(pick(b.setterEmail) || '').trim().toLowerCase();
      const closerEmail = String(pick(b.closerEmail, cal?.scheduled_event?.event_memberships?.[0]?.user_email) || '').trim().toLowerCase();
      const presupuesto = ['con', 'sin'].includes(b.presupuesto) ? b.presupuesto : '';
      const origen = String(pick(b.origen, cal ? 'calendly' : 'webhook')).slice(0, 40);
      const ref = String(pick(b.ref, cal?.uri) || '').slice(0, 300) || null;
      const [setter] = setterEmail ? await query('select id from ml_usuarios where email = $1', [setterEmail]) : [];
      const [closer] = closerEmail ? await query('select id from ml_usuarios where email = $1', [closerEmail]) : [];
      if (ref) {
        const [ex] = await query('select id from ml_ventas where ref_externa = $1', [ref]);
        if (ex) return { ok: true, id: ex.id, duplicada: true };
      }
      const [v] = await query(
        `insert into ml_ventas (nombre, telefono, email, instagram, contact_id, fecha_llamada, proxima_accion, setter_id, closer_id, presupuesto, origen, ref_externa, etapa_id, orden)
         values ($1, $2, $3, $4, $5, $6, coalesce($6, now()), $7, $8, $9, $10, $11,
                 (select id from ml_etapas order by (tipo = 'entrada') desc, orden limit 1),
                 (select coalesce(max(orden), 0) + 1 from ml_ventas))
         on conflict (ref_externa) where ref_externa is not null do nothing
         returning id`,
        [nombre, telefono, email, instagram, contactId, fecha, setter?.id || null, closer?.id || null, presupuesto, origen, ref],
      );
      return { ok: true, id: v?.id || null };
    },
  },
  {
    method: 'GET',
    path: '/events',
    auth: 'admin',
    handler: async ({ query: q }) => {
      const onlyUnmatched = q.sinMatch === '1';
      const rows = await query(
        `select e.id, e.tipo, e.contact_id, e.codigo, e.setter_email, e.usuario_ig, e.nombre, e.recibido,
                e.contenido_id, c.titulo as contenido_titulo, u.nombre as setter_nombre
           from ml_eventos e
           left join ml_contenido c on c.id = e.contenido_id
           left join ml_usuarios u on u.id = e.setter_id
          ${onlyUnmatched ? "where e.tipo = 'content_reply' and e.contenido_id is null" : ''}
          order by e.recibido desc limit 200`,
      );
      return { events: rows };
    },
  },
  {
    method: 'POST',
    path: '/events/:id/match',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const contenidoId = await validContenido((await body()).contenidoId);
      const [ev] = await query('update ml_eventos set contenido_id = $2 where id::text = $1 returning id', [String(params.id), contenidoId]);
      if (!ev) throw new HttpError(404, 'No existe ese aviso');
      return { ok: true };
    },
  },
  {
    // Asignar varios avisos al mismo contenido de una vez (cola «Sin match»).
    method: 'POST',
    path: '/events/match',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 2000);
      if (!ids.length) throw new HttpError(400, 'Faltan los avisos');
      const contenidoId = await validContenido(b.contenidoId);
      const rows = await query('update ml_eventos set contenido_id = $2 where id = any($1::uuid[]) returning id', [ids, contenidoId]);
      return { ok: true, actualizados: rows.length };
    },
  },
];
