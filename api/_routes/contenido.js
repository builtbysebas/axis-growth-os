// Contenido: planificador de posts, historias y ads (calendario/lista), con el
// código único que viaja a ManyChat, recursos vinculados, comentarios y la
// atribución automática (leads, agendas, ventas y cash). También ángulos y
// recursos (Cápsula de Recursos).
//
// Todos los roles logueados ven posts e historias; los ads solo un admin
// (llevan gasto). Crear, editar y borrar: solo admin (como la versión completa).
import { query, tx } from '../_lib/db.js';
import { HttpError } from '../_lib/http.js';
import { effectiveContentSql, VENTAS_CERRADAS_SQL } from '../_lib/metrics.js';
import { dateOrNull, isAdmin, numOrNull, out, requireUuid, text, uuidOrNull } from '../_lib/util.js';

// ---------------------------------------------------------------- listas fijas
export const KINDS = ['post', 'story', 'ad'];
export const ESTADOS = ['idea', 'guion', 'grabado', 'editado', 'programado', 'publicado'];
export const ESTADOS_AD = ['activo', 'pausado', 'terminado'];
export const FORMATOS = ['Reel', 'Carrusel animado', 'Carrusel con foto', 'Carrusel caso de éxito', 'Foto', 'Video largo'];
export const TIPOS_STORY = ['Poll', 'CTA', 'Q&A', 'Recurso Gratis', 'Encuesta', 'Caja de preguntas', 'Libre'];
const PREFIJO = { post: 'P', story: 'S', ad: 'A' };

// ---------------------------------------------------------------- tipos de carrusel
// Igual que la versión completa (lib/carousel-type.ts): el tipo de carrusel va también al
// comienzo del título ("CARRUSEL ANIMADO: …"); el código de ManyChat no depende de él.
const CAROUSEL_TYPES = [
  { format: 'Carrusel animado', prefix: 'CARRUSEL ANIMADO' },
  { format: 'Carrusel con foto', prefix: 'CARRUSEL CON FOTO' },
  { format: 'Carrusel caso de éxito', prefix: 'CARRUSEL CASO DE ÉXITO' },
];
const TYPED_PREFIX = /^\s*carrusel\s+(animado|(con\s+)?foto(\s+de\s+\S+)?|(de\s+)?caso(\s+de)?\s+[eé]xito)\s*[:·\-–—|]\s*/i;
const ANY_PREFIX = /^\s*carrusel(\s+(animado|(con\s+)?foto(\s+de\s+\S+)?|(de\s+)?caso(\s+de)?\s+[eé]xito))?\s*[:·\-–—|]\s*/i;

export function stripCarouselPrefix(title) {
  return String(title || '').replace(ANY_PREFIX, '').trim();
}

/** Título que corresponde al formato (solo posts). */
export function titleForFormat(title, format) {
  const type = CAROUSEL_TYPES.find((t) => t.format === format);
  if (type) {
    const rest = stripCarouselPrefix(title);
    return rest ? `${type.prefix}: ${rest}` : type.prefix;
  }
  const rest = String(title || '').replace(TYPED_PREFIX, '').trim();
  return rest || String(title || '');
}

// ---------------------------------------------------------------- código para ManyChat
const plain = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/** PALABRA del código: el CTA o, si no hay, las primeras palabras del título. */
export function codeWord({ cta, titulo }) {
  const c = plain(cta);
  if (c) return c.slice(0, 60).trim();
  const t = plain(stripCarouselPrefix(titulo) || titulo);
  return t.split(' ').slice(0, 3).join(' ') || 'CONTENIDO';
}

/** "P - CALCULADORA - 26/08/2026" (sin el número de repetido). */
export function codeBase({ kind, cta, titulo, fecha }) {
  const [y, m, d] = String(fecha).slice(0, 10).split('-');
  return `${PREFIJO[kind]} - ${codeWord({ cta, titulo })} - ${d}/${m}/${y}`;
}

/** ¿El código actual ya corresponde a esa base (con o sin " 2", " 3"…)? */
function codeMatchesBase(codigo, base) {
  if (codigo === base) return true;
  return codigo.startsWith(`${base} `) && /^\d+$/.test(codigo.slice(base.length + 1));
}

/** Código libre: la base o la base + " 2", " 3"… (dentro de la transacción, con candado). */
async function uniqueCode(c, base, excludeId = null) {
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const { rows } = await c.query('select 1 from ml_contenido where codigo = $1 and id is distinct from $2 limit 1', [candidate, excludeId]);
    if (!rows.length) return candidate;
    candidate = `${base} ${n}`;
  }
  throw new HttpError(409, 'No se pudo generar un código libre para este contenido.');
}

// ---------------------------------------------------------------- validación
function linkOrEmpty(v, what = 'El link') {
  const s = text(v, 2000);
  if (!s) return '';
  if (!/^https?:\/\/\S+$/i.test(s)) throw new HttpError(400, `${what} tiene que empezar con http:// o https://`);
  return s;
}

function adminOnlyAd(user, kind) {
  if (kind === 'ad' && !isAdmin(user)) throw new HttpError(403, 'Los ads solo los puede ver un admin');
}

/** Campos editables que llegan de la pantalla (solo los permitidos y validados). */
function cleanFields(b, kind) {
  const o = {};
  if (b.titulo !== undefined) {
    o.titulo = text(b.titulo, 300);
    if (!o.titulo) throw new HttpError(400, 'Falta el título');
  }
  if (b.fecha !== undefined) {
    o.fecha = dateOrNull(b.fecha);
    if (!o.fecha) throw new HttpError(400, 'Elige una fecha válida');
  }
  if (b.estado !== undefined) {
    const list = kind === 'ad' ? ESTADOS_AD : ESTADOS;
    if (!list.includes(b.estado)) throw new HttpError(400, `El estado tiene que ser uno de: ${list.join(', ')}`);
    o.estado = b.estado;
  }
  if (b.formato !== undefined) {
    const f = text(b.formato, 80);
    if (f && kind !== 'post') throw new HttpError(400, 'El formato es solo para contenido corto');
    if (f && !FORMATOS.includes(f)) throw new HttpError(400, 'Formato inválido');
    o.formato = f;
  }
  if (b.tipo_story !== undefined) {
    const t = text(b.tipo_story, 80);
    if (t && kind !== 'story') throw new HttpError(400, 'El tipo de story es solo para historias');
    if (t && !TIPOS_STORY.includes(t)) throw new HttpError(400, 'Tipo de story inválido');
    o.tipo_story = t;
  }
  if (b.angulo_id !== undefined) {
    if (b.angulo_id === null || b.angulo_id === '') o.angulo_id = null;
    else {
      o.angulo_id = uuidOrNull(b.angulo_id);
      if (!o.angulo_id) throw new HttpError(400, 'No existe ese ángulo');
    }
  }
  for (const [f, max] of [
    ['cta', 120],
    ['gancho', 1000],
    ['etiqueta', 80],
  ]) {
    if (b[f] !== undefined) o[f] = text(b[f], max);
  }
  if (b.guion !== undefined) o.guion = String(b.guion ?? '').slice(0, 100_000);
  if (b.link !== undefined) o.link = linkOrEmpty(b.link);
  if (b.gasto !== undefined) {
    if (kind !== 'ad' && b.gasto !== null && b.gasto !== '') throw new HttpError(400, 'El gasto es solo para ads');
    const g = numOrNull(b.gasto);
    if (g !== null && g < 0) throw new HttpError(400, 'El gasto no puede ser negativo');
    o.gasto = g;
  }
  return o;
}

async function assertAngulo(c, id) {
  if (!id) return;
  const { rows } = await c.query('select 1 from ml_angulos where id = $1', [id]);
  if (!rows.length) throw new HttpError(400, 'No existe ese ángulo');
}

function cleanRecursoIds(v) {
  if (!Array.isArray(v)) throw new HttpError(400, 'recurso_ids tiene que ser una lista');
  const ids = [...new Set(v.map(uuidOrNull))];
  if (ids.includes(null)) throw new HttpError(400, 'Hay un recurso inválido');
  return ids.slice(0, 200);
}

// ---------------------------------------------------------------- lectura
/**
 * Contenidos con su atribución automática:
 *  - leads: contactos distintos que respondieron a ESE contenido (aviso content_reply);
 *  - agendas: agendas cuyo contenido efectivo es este (manual > último contenido antes de agendar);
 *  - ventas y cash (venta + cuotas, sin renovaciones) de esas agendas.
 */
async function loadItems({ kind = null, id = null, kinds = KINDS, withGuion = false } = {}) {
  const params = [kinds];
  let where = 'c.kind = any($1)';
  if (kind) {
    params.push(kind);
    where += ` and c.kind = $${params.length}`;
  }
  if (id) {
    params.push(id);
    where += ` and c.id = $${params.length}`;
  }
  const rows = await query(
    `with eff as (
       select v.id as venta_id, ${effectiveContentSql('v')} as cid from ml_ventas v
     ),
     ag as (
       select cid, count(*)::int as agendas from eff where cid is not null group by cid
     ),
     vt as (
       select e.cid, count(*)::int as ventas, coalesce(sum(p.cash), 0) as cash
         from eff e
         join (${VENTAS_CERRADAS_SQL}) vc on vc.venta_id = e.venta_id
         left join lateral (
           select coalesce(sum(pg.monto), 0) as cash from ml_pagos pg
            where pg.cliente_id = vc.cliente_id and pg.renovacion_id is null
         ) p on true
        where e.cid is not null
        group by e.cid
     ),
     ld as (
       select contenido_id as cid, count(distinct contact_id)::int as leads
         from ml_eventos
        where tipo = 'content_reply' and contenido_id is not null and contact_id <> ''
        group by contenido_id
     )
     select c.id, c.kind, c.titulo, c.codigo, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.estado, c.formato,
            c.tipo_story, c.angulo_id, a.nombre as angulo_nombre, c.cta, c.gancho, c.etiqueta, c.link, c.gasto,
            c.creado, c.actualizado${withGuion ? ', c.guion' : ''},
            coalesce(ld.leads, 0) as leads, coalesce(ag.agendas, 0) as agendas,
            coalesce(vt.ventas, 0) as ventas, coalesce(vt.cash, 0) as cash,
            coalesce((select array_agg(cr.recurso_id::text) from ml_contenido_recursos cr where cr.contenido_id = c.id), '{}') as recurso_ids
       from ml_contenido c
       left join ml_angulos a on a.id = c.angulo_id
       left join ld on ld.cid = c.id
       left join ag on ag.cid = c.id
       left join vt on vt.cid = c.id
      where ${where}
      order by c.fecha nulls last, c.creado`,
    params,
  );
  return rows.map((r) => ({
    ...out(r),
    leads: Number(r.leads),
    agendas: Number(r.agendas),
    ventas: Number(r.ventas),
    cash: Number(r.cash),
    recurso_ids: r.recurso_ids || [],
  }));
}

async function loadItem(id, user, opts = {}) {
  const [it] = await loadItems({ id: requireUuid(id, 'contenido'), ...opts });
  if (!it) throw new HttpError(404, 'No existe ese contenido');
  adminOnlyAd(user, it.kind);
  return it;
}

const angulosList = () =>
  query(
    `select a.id, a.nombre, a.descripcion, a.orden,
            (select count(*)::int from ml_contenido c where c.angulo_id = a.id) as usos
       from ml_angulos a order by a.orden, a.nombre`,
  );

const recursosList = () =>
  query(
    `select r.id, r.nombre, r.link, r.tipo, r.descripcion, r.creado,
            (select count(*)::int from ml_contenido_recursos cr where cr.recurso_id = r.id) as usos
       from ml_recursos r order by lower(r.nombre)`,
  );

const recursosDe = (contenidoId) =>
  query(
    `select r.id, r.nombre, r.link, r.tipo from ml_contenido_recursos cr
       join ml_recursos r on r.id = cr.recurso_id
      where cr.contenido_id = $1 order by lower(r.nombre)`,
    [contenidoId],
  );

// ---------------------------------------------------------------- rutas
export const routes = [
  // ------------------------------------------------------------ contenidos
  {
    method: 'GET',
    path: '/contenido',
    auth: 'user',
    handler: async ({ query: q, user }) => {
      const kind = q.kind ? String(q.kind) : null;
      if (kind && !KINDS.includes(kind)) throw new HttpError(400, 'kind tiene que ser post, story o ad');
      adminOnlyAd(user, kind);
      const kinds = isAdmin(user) ? KINDS : ['post', 'story'];
      const [items, angulos, recursos] = await Promise.all([loadItems({ kind, kinds }), angulosList(), recursosList()]);
      return { items, angulos, recursos };
    },
  },
  {
    // Buscador corto para otras pantallas (atribución, resultados…).
    method: 'GET',
    path: '/contenido/buscar',
    auth: 'user',
    handler: async ({ query: q, user }) => {
      const kinds = isAdmin(user) ? KINDS : ['post', 'story'];
      const term = text(q.q, 120)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[%_\\]/g, (ch) => `\\${ch}`);
      const strip = (col) => `translate(lower(${col}), 'áéíóúüñàèìòù', 'aeiouunaeiou')`;
      const rows = await query(
        `select id, kind, titulo, codigo, to_char(fecha, 'YYYY-MM-DD') as fecha
           from ml_contenido
          where kind = any($1)
            and ($2 = '' or ${strip('titulo')} like '%' || $2 || '%' or ${strip('codigo')} like '%' || $2 || '%'
                 or ${strip('cta')} like '%' || $2 || '%')
          order by fecha desc nulls last, creado desc
          limit 20`,
        [kinds, term],
      );
      return { items: rows.map(out) };
    },
  },
  {
    method: 'GET',
    path: '/contenido/:id',
    auth: 'user',
    handler: async ({ params, user }) => {
      const item = await loadItem(params.id, user, { withGuion: true });
      const [recursos, notas] = await Promise.all([
        recursosDe(item.id),
        query(
          `select n.id, n.texto, n.creado, u.nombre as autor from ml_contenido_notas n
             left join ml_usuarios u on u.id = n.user_id
            where n.contenido_id = $1 order by n.creado desc`,
          [item.id],
        ),
      ]);
      return { item, recursos, notas: notas.map(out) };
    },
  },
  {
    method: 'POST',
    path: '/contenido',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const kind = String(b.kind || '');
      if (!KINDS.includes(kind)) throw new HttpError(400, 'kind tiene que ser post, story o ad');
      const f = cleanFields(b, kind);
      if (!f.titulo) throw new HttpError(400, 'Falta el título');
      if (!f.fecha) throw new HttpError(400, 'Elige la fecha');
      if (kind === 'post' && f.formato) f.titulo = titleForFormat(f.titulo, f.formato);
      f.estado ||= kind === 'ad' ? 'pausado' : 'idea';
      const recursoIds = b.recurso_ids !== undefined ? cleanRecursoIds(b.recurso_ids) : [];
      const id = await tx(async (c) => {
        await c.query('select pg_advisory_xact_lock(726345101)');
        await assertAngulo(c, f.angulo_id);
        const codigo = await uniqueCode(c, codeBase({ kind, cta: f.cta, titulo: f.titulo, fecha: f.fecha }));
        const cols = Object.keys(f);
        const { rows } = await c.query(
          `insert into ml_contenido (kind, codigo${cols.map((k) => `, ${k}`).join('')})
           values ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) returning id`,
          [kind, codigo, ...cols.map((k) => f[k])],
        );
        for (const rid of recursoIds) {
          await c.query('insert into ml_contenido_recursos (contenido_id, recurso_id) select $1, id from ml_recursos where id = $2 on conflict do nothing', [
            rows[0].id,
            rid,
          ]);
        }
        return rows[0].id;
      });
      const [item] = await loadItems({ id });
      return { item };
    },
  },
  {
    method: 'PATCH',
    path: '/contenido/:id',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const id = requireUuid(params.id, 'contenido');
      const b = await body();
      let aviso = '';
      await tx(async (c) => {
        await c.query('select pg_advisory_xact_lock(726345101)');
        const { rows } = await c.query(`select *, to_char(fecha, 'YYYY-MM-DD') as fecha_s from ml_contenido where id = $1 for update`, [id]);
        const cur = rows[0];
        if (!cur) throw new HttpError(404, 'No existe ese contenido');
        const f = cleanFields(b, cur.kind);
        if ('angulo_id' in f) await assertAngulo(c, f.angulo_id);
        // Posts: el título lleva el prefijo del tipo de carrusel elegido.
        if (cur.kind === 'post' && ('titulo' in f || 'formato' in f)) {
          const t = titleForFormat(f.titulo ?? cur.titulo, 'formato' in f ? f.formato : cur.formato);
          if (t !== cur.titulo || 'titulo' in f) f.titulo = t;
        }
        // Código: se rehace si cambian CTA, título o fecha… salvo que ManyChat ya lo use.
        if ('titulo' in f || 'cta' in f || 'fecha' in f) {
          const base = codeBase({
            kind: cur.kind,
            cta: 'cta' in f ? f.cta : cur.cta,
            titulo: f.titulo ?? cur.titulo,
            fecha: f.fecha ?? cur.fecha_s,
          });
          if (cur.fecha_s && !codeMatchesBase(cur.codigo, base)) {
            const { rows: ev } = await c.query('select 1 from ml_eventos where contenido_id = $1 limit 1', [id]);
            if (ev.length) {
              aviso = `El código no cambió porque ManyChat ya mandó avisos con «${cur.codigo}». Si lo cambias, también hay que cambiarlo en ManyChat.`;
            } else {
              f.codigo = await uniqueCode(c, base, id);
            }
          } else if (!cur.fecha_s) {
            f.codigo = await uniqueCode(c, base, id);
          }
        }
        const cols = Object.keys(f);
        if (cols.length) {
          await c.query(
            `update ml_contenido set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, actualizado = now() where id = $1`,
            [id, ...cols.map((k) => f[k])],
          );
        }
        if (b.recurso_ids !== undefined) {
          const ids = cleanRecursoIds(b.recurso_ids);
          await c.query('delete from ml_contenido_recursos where contenido_id = $1', [id]);
          for (const rid of ids) {
            await c.query('insert into ml_contenido_recursos (contenido_id, recurso_id) select $1, id from ml_recursos where id = $2 on conflict do nothing', [id, rid]);
          }
        }
      });
      const [item] = await loadItems({ id, withGuion: true });
      return aviso ? { item, aviso } : { item };
    },
  },
  {
    method: 'DELETE',
    path: '/contenido/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'contenido');
      await tx(async (c) => {
        const { rowCount } = await c.query('delete from ml_contenido where id = $1', [id]);
        if (!rowCount) throw new HttpError(404, 'No existe ese contenido');
        // Los avisos de ManyChat quedan en «Sin match» (nunca se pierde un lead) y las
        // agendas atribuidas a mano vuelven a la atribución automática.
        await c.query('update ml_eventos set contenido_id = null where contenido_id = $1', [id]);
        await c.query('update ml_ventas set atrib_contenido_id = null where atrib_contenido_id = $1', [id]);
      });
      return { ok: true };
    },
  },
  {
    method: 'POST',
    path: '/contenido/:id/recursos',
    auth: 'admin',
    handler: async ({ params, body, user }) => {
      const item = await loadItem(params.id, user);
      const rid = uuidOrNull((await body()).recurso_id);
      const [r] = rid ? await query('select id from ml_recursos where id = $1', [rid]) : [];
      if (!r) throw new HttpError(404, 'No existe ese recurso');
      await query('insert into ml_contenido_recursos (contenido_id, recurso_id) values ($1, $2) on conflict do nothing', [item.id, r.id]);
      return { recursos: await recursosDe(item.id) };
    },
  },
  {
    method: 'DELETE',
    path: '/contenido/:id/recursos/:recursoId',
    auth: 'admin',
    handler: async ({ params, user }) => {
      const item = await loadItem(params.id, user);
      const rid = uuidOrNull(params.recursoId);
      if (rid) await query('delete from ml_contenido_recursos where contenido_id = $1 and recurso_id = $2', [item.id, rid]);
      return { recursos: await recursosDe(item.id) };
    },
  },
  {
    method: 'POST',
    path: '/contenido/:id/notas',
    auth: 'admin',
    handler: async ({ params, body, user }) => {
      const item = await loadItem(params.id, user);
      const t = text((await body()).texto, 5000);
      if (!t) throw new HttpError(400, 'Escribe el comentario');
      const [n] = await query('insert into ml_contenido_notas (contenido_id, user_id, texto) values ($1, $2, $3) returning id, texto, creado', [
        item.id,
        user.id,
        t,
      ]);
      return { nota: { ...n, autor: user.nombre } };
    },
  },

  // ------------------------------------------------------------ ángulos
  { method: 'GET', path: '/angulos', auth: 'user', handler: async () => ({ angulos: await angulosList() }) },
  {
    method: 'POST',
    path: '/angulos',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const nombre = text(b.nombre, 120);
      if (!nombre) throw new HttpError(400, 'Falta el nombre del ángulo');
      const [a] = await query(
        `insert into ml_angulos (nombre, descripcion, orden)
         values ($1, $2, (select coalesce(max(orden), 0) + 1 from ml_angulos)) returning id`,
        [nombre, text(b.descripcion, 2000)],
      );
      return { angulo: (await angulosList()).find((x) => x.id === a.id) };
    },
  },
  {
    // Reordenar: { ids: [...] } en el orden nuevo (los que falten quedan al final).
    method: 'POST',
    path: '/angulos/orden',
    auth: 'admin',
    handler: async ({ body }) => {
      const ids = (await body()).ids;
      if (!Array.isArray(ids)) throw new HttpError(400, 'Falta la lista de ángulos');
      const clean = ids.map(uuidOrNull).filter(Boolean).slice(0, 500);
      await tx(async (c) => {
        for (const [i, id] of clean.entries()) await c.query('update ml_angulos set orden = $2 where id = $1', [id, i + 1]);
        await c.query('update ml_angulos set orden = orden + $1 where not (id = any($2))', [clean.length + 1, clean]);
      });
      return { angulos: await angulosList() };
    },
  },
  {
    method: 'PATCH',
    path: '/angulos/:id',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const id = requireUuid(params.id, 'ángulo');
      const b = await body();
      const sets = [];
      const vals = [id];
      if (b.nombre !== undefined) {
        const n = text(b.nombre, 120);
        if (!n) throw new HttpError(400, 'Falta el nombre del ángulo');
        vals.push(n);
        sets.push(`nombre = $${vals.length}`);
      }
      if (b.descripcion !== undefined) {
        vals.push(text(b.descripcion, 2000));
        sets.push(`descripcion = $${vals.length}`);
      }
      if (sets.length) {
        const r = await query(`update ml_angulos set ${sets.join(', ')} where id = $1 returning id`, vals);
        if (!r.length) throw new HttpError(404, 'No existe ese ángulo');
      }
      const a = (await angulosList()).find((x) => x.id === id);
      if (!a) throw new HttpError(404, 'No existe ese ángulo');
      return { angulo: a };
    },
  },
  {
    method: 'DELETE',
    path: '/angulos/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'ángulo');
      const r = await query('delete from ml_angulos where id = $1 returning id', [id]);
      if (!r.length) throw new HttpError(404, 'No existe ese ángulo');
      return { ok: true };
    },
  },

  // ------------------------------------------------------------ recursos
  { method: 'GET', path: '/recursos', auth: 'user', handler: async () => ({ recursos: await recursosList() }) },
  {
    method: 'POST',
    path: '/recursos',
    auth: 'admin',
    handler: async ({ body }) => {
      const b = await body();
      const nombre = text(b.nombre, 200);
      if (!nombre) throw new HttpError(400, 'Falta el nombre del recurso');
      const [r] = await query('insert into ml_recursos (nombre, link, tipo, descripcion) values ($1, $2, $3, $4) returning id', [
        nombre,
        linkOrEmpty(b.link),
        text(b.tipo, 80),
        text(b.descripcion, 2000),
      ]);
      return { recurso: (await recursosList()).find((x) => x.id === r.id) };
    },
  },
  {
    method: 'PATCH',
    path: '/recursos/:id',
    auth: 'admin',
    handler: async ({ params, body }) => {
      const id = requireUuid(params.id, 'recurso');
      const b = await body();
      const sets = [];
      const vals = [id];
      const add = (col, v) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (b.nombre !== undefined) {
        const n = text(b.nombre, 200);
        if (!n) throw new HttpError(400, 'Falta el nombre del recurso');
        add('nombre', n);
      }
      if (b.link !== undefined) add('link', linkOrEmpty(b.link));
      if (b.tipo !== undefined) add('tipo', text(b.tipo, 80));
      if (b.descripcion !== undefined) add('descripcion', text(b.descripcion, 2000));
      if (sets.length) {
        const r = await query(`update ml_recursos set ${sets.join(', ')} where id = $1 returning id`, vals);
        if (!r.length) throw new HttpError(404, 'No existe ese recurso');
      }
      const rec = (await recursosList()).find((x) => x.id === id);
      if (!rec) throw new HttpError(404, 'No existe ese recurso');
      return { recurso: rec };
    },
  },
  {
    method: 'DELETE',
    path: '/recursos/:id',
    auth: 'admin',
    handler: async ({ params }) => {
      const id = requireUuid(params.id, 'recurso');
      const r = await query('delete from ml_recursos where id = $1 returning id', [id]);
      if (!r.length) throw new HttpError(404, 'No existe ese recurso');
      return { ok: true };
    },
  },
];
