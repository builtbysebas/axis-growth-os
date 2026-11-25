// Enrutador propio: TODA la API vive en una sola función de Vercel
// (api/main.js). El plan gratis de Vercel permite máx. 12 funciones, así
// que cada módulo registra sus rutas acá en vez de tener un archivo por ruta.
//
// Cada módulo (api/_routes/<modulo>.js) exporta `routes`:
//   [{ method: 'GET', path: '/clients/:id', auth: 'user', handler: async (ctx) => ... }]
// auth: 'public' | 'user' | 'admin' | ['setter', 'closer', ...] (admin siempre pasa)
// ctx = { req, res, params, query, user, body() }  → lo que devuelve el handler va como JSON.
import { ensureReady } from './db.js';
import { HttpError, readBody, send, handleError } from './http.js';
import { requireUser } from './users.js';

function compile(path) {
  const keys = [];
  const re = new RegExp(
    '^' +
      path.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k);
        return '/([^/]+)';
      }) +
      '/?$',
  );
  return { re, keys };
}

export function createRouter(modules) {
  const table = [];
  for (const mod of modules) {
    for (const r of mod.routes || []) table.push({ ...r, ...compile(r.path) });
  }
  return async function route(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      // En Vercel todo /api/* llega reescrito a /api/main?__path=… (ver vercel.json).
      const rewritten = url.searchParams.get('__path');
      url.searchParams.delete('__path');
      const path = rewritten != null ? '/' + rewritten.replace(/^\/+/, '') : url.pathname.replace(/^\/api/, '') || '/';
      let pathMatched = false;
      for (const r of table) {
        const m = path.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const query = Object.fromEntries(url.searchParams);
        if (r.db !== false) await ensureReady();
        let user = null;
        if (r.auth && r.auth !== 'public') {
          const role = r.auth === 'user' ? undefined : r.auth;
          user = requireUser(req, { role });
        }
        let bodyCache;
        const ctx = {
          req,
          res,
          params,
          query,
          user,
          body: async () => (bodyCache ??= await readBody(req)),
        };
        const out = await r.handler(ctx);
        if (!res.writableEnded) send(res, 200, out ?? { ok: true });
        return;
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Método no permitido' : 'No existe');
    } catch (err) {
      handleError(res, err);
    }
  };
}
