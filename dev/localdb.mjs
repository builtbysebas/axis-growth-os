// Postgres de mentira para probar en la compu (PGlite = Postgres real compilado
// a WebAssembly). Se conecta igual que Neon o Supabase: por DATABASE_URL.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/** dir = carpeta donde guardar (null = solo en memoria). Devuelve { url, stop }. */
export async function startLocalDb({ dir = null, port = 0 } = {}) {
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  if (!port) port = 20000 + Math.floor(Math.random() * 20000);
  // Una sola conexión: PGlite corre todo en un hilo y así una transacción no se
  // mezcla con consultas de otra conexión. La app usa DB_POOL_MAX=1 en local.
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
