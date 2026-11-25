// Servidor local que imita a Vercel: sirve public/ y pasa /api/* a la función
// única api/main.js. La base es un Postgres local (PGlite) en dev/.pgdata.
//   npm run dev  →  http://localhost:3010
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLocalDb } from './localdb.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3010);

process.env.LOCAL_DEV = '1';
process.env.DB_POOL_MAX = '1';
if (!process.env.DATABASE_URL) {
  const local = await startLocalDb({ dir: process.env.PGDATA_DIR || path.join(root, 'dev/.pgdata'), port: Number(process.env.PGPORT || 55433) });
  process.env.DATABASE_URL = local.url;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
const api = (await import(pathToFileURL(path.join(root, 'api/main.js')).href)).default;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res);
      let file = path.join(root, 'public', decodeURIComponent(url.pathname));
      if (!file.startsWith(path.join(root, 'public'))) throw new Error('ruta');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'public/index.html');
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.end('error');
    }
  })
  .listen(PORT, () => console.log(`Axis Growth OS local: http://localhost:${PORT}`));
