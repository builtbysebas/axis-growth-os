// Base de datos: Postgres (Neon o Supabase, conectados desde Vercel → Storage).
// Vercel pone la dirección en DATABASE_URL (Neon) o POSTGRES_URL (Supabase).
// Las tablas se crean solas la primera vez: la clienta no corre nada a mano.
import crypto from 'node:crypto';
import pg from 'pg';
import { sql as BASE } from './schema/base.js';
import { sql as VENTAS, ETAPAS_INICIALES } from './schema/ventas.js';
import { sql as CLIENTES, CLIENTE_ETAPAS_INICIALES } from './schema/clientes.js';
import { sql as CONTENIDO } from './schema/contenido.js';
import { sql as EQUIPO, PREGUNTAS_INICIALES } from './schema/equipo.js';
import { sql as RELACIONES } from './schema/relaciones.js';


// Fechas: siempre como texto ISO hacia la pantalla.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz

export class DbError extends Error {}

// Vercel puede agregar un prefijo al nombre (ej. STORAGE_DATABASE_URL).
// Se prefiere la dirección con pooler (sin _UNPOOLED / _NON_POOLING).
const URL_NAMES = /(^|_)(DATABASE_URL|POSTGRES_URL)(_UNPOOLED|_NON_POOLING)?$/;

export function dbUrl() {
  const keys = Object.keys(process.env).filter((k) => URL_NAMES.test(k) && /^postgres(ql)?:\/\//.test(process.env[k] || ''));
  const rank = (k) => (k === 'DATABASE_URL' ? 0 : k === 'POSTGRES_URL' ? 1 : /UNPOOLED|NON_POOLING/.test(k) ? 3 : 2);
  keys.sort((a, b) => rank(a) - rank(b));
  return keys.length ? process.env[keys[0]].trim() : '';
}

/** Solo nombres (nunca valores) de variables que parecen de base de datos, para diagnosticar. */
export function dbEnvNames() {
  return Object.keys(process.env).filter((k) => /DATABASE|POSTGRES|^PG|NEON/.test(k)).sort();
}

let pool;
function getPool() {
  if (pool) return pool;
  const raw = dbUrl();
  if (!raw) throw new DbError('Falta conectar la base de datos (Vercel → Storage).');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DbError('La dirección de la base de datos no es válida.');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  // sslmode en la dirección hace que pg verifique el certificado de una forma que
  // falla con el pooler de Supabase; la conexión igual va cifrada.
  url.searchParams.delete('sslmode');
  pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => console.error('[db] conexión caída', err.message));
  return pool;
}

export async function query(text, params = []) {
  try {
    return (await getPool().query(text, params)).rows;
  } catch (err) {
    if (err instanceof DbError) throw err;
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '28P01', '3D000'].includes(err.code) || /timeout|terminated/i.test(err.message)) {
      console.error('[db]', err.code, err.message);
      throw new DbError('No se pudo conectar con la base de datos.');
    }
    throw err;
  }
}

/** Corre fn(client) dentro de una transacción. */
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- tablas
// Cada módulo trae su SQL (todo idempotente: create/alter ... if not exists).
const SCHEMA = [BASE, VENTAS, CLIENTES, CONTENIDO, EQUIPO, RELACIONES].join('\n');

async function seedIfEmpty(c, table, rows, insert) {
  const { rows: r } = await c.query(`select count(*)::int as n from ${table}`);
  if (r[0].n === 0) for (const [i, row] of rows.entries()) await c.query(insert, [...row, i + 1]);
}

let ready = null;
let appSecret = null;

/** Crea las tablas (si faltan) y carga la clave de la app. Una vez por instancia. */
export function ensureReady() {
  if (!ready) {
    ready = tx(async (c) => {
      // Candado para que dos pedidos simultáneos no creen las tablas a la vez.
      await c.query('select pg_advisory_xact_lock(726345001)');
      await c.query(SCHEMA);
      await seedIfEmpty(c, 'ml_etapas', ETAPAS_INICIALES, 'insert into ml_etapas (nombre, tipo, orden) values ($1, $2, $3)');
      await seedIfEmpty(c, 'ml_cliente_etapas', CLIENTE_ETAPAS_INICIALES, 'insert into ml_cliente_etapas (nombre, tipo, orden) values ($1, $2, $3)');
      await seedIfEmpty(c, 'ml_eod_preguntas', PREGUNTAS_INICIALES, 'insert into ml_eod_preguntas (texto, tipo, roles, orden) values ($1, $2, $3, $4)');
      await c.query("insert into ml_settings (key, value) values ('secret', $1) on conflict (key) do nothing", [
        crypto.randomBytes(32).toString('hex'),
      ]);
      const s = await c.query("select value from ml_settings where key = 'secret'");
      appSecret = s.rows[0].value;
    }).catch((err) => {
      ready = null; // reintentar en el próximo pedido
      if (err instanceof DbError) throw err;
      console.error('[db] preparar tablas', err.code, err.message);
      throw new DbError('No se pudo preparar la base de datos.');
    });
  }
  return ready;
}

/** Claves propias de la app (sesión, ManyChat), derivadas de la clave guardada en la base. */
export function derivedSecret(purpose) {
  if (!appSecret) throw new Error('Base no preparada');
  return crypto.createHmac('sha256', appSecret).update(`axis-growth-os:${purpose}`).digest('hex');
}

/** Para las pruebas: soltar la conexión y olvidar lo cargado. */
export async function resetForTests() {
  if (pool) await pool.end();
  pool = undefined;
  ready = null;
  appSecret = null;
}
