// Conexión directa con Calendly (sin n8n, Make ni Zapier).
//
// El admin pega en Ajustes un «token personal» de Calendly. Con ese token se crea
// en Calendly una suscripción de webhooks que manda cada agenda, reagenda y
// cancelación directo a /api/webhooks/agenda (que procesa core.js). El token NO
// se guarda: solo se usa en ese momento. Para desconectar se vuelve a pegar.
import { derivedSecret, query } from '../_lib/db.js';
import { HttpError } from '../_lib/http.js';

const API = 'https://api.calendly.com';
const EVENTS = ['invitee.created', 'invitee.canceled'];

function ourWebhookUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/webhooks/agenda?k=${derivedSecret('manychat')}`;
}

async function cal(token, method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta sin JSON */
  }
  return { status: res.status, json };
}

function cleanToken(t) {
  const token = String(t || '').trim().replace(/^Bearer\s+/i, '');
  if (token.length < 20 || /\s/.test(token)) throw new HttpError(400, 'Pega el token completo de Calendly (es un texto largo, sin espacios).');
  return token;
}

async function whoAmI(token) {
  const me = await cal(token, 'GET', '/users/me');
  if (me.status === 401) throw new HttpError(400, 'Calendly no aceptó ese token. Revisa que lo hayas copiado completo o crea uno nuevo.');
  if (me.status !== 200 || !me.json?.resource) throw new HttpError(502, `Calendly no respondió bien (código ${me.status}). Prueba de nuevo en un rato.`);
  return me.json.resource;
}

/** Suscripciones de Calendly que apuntan a esta app (organización y usuario). */
async function ourSubscriptions(token, me, host) {
  const found = [];
  const lists = [
    `/webhook_subscriptions?organization=${encodeURIComponent(me.current_organization)}&scope=organization&count=100`,
    `/webhook_subscriptions?organization=${encodeURIComponent(me.current_organization)}&user=${encodeURIComponent(me.uri)}&scope=user&count=100`,
  ];
  for (const path of lists) {
    const r = await cal(token, 'GET', path);
    for (const s of r.json?.collection || []) {
      try {
        if (new URL(s.callback_url).host === host && new URL(s.callback_url).pathname === '/api/webhooks/agenda') found.push(s);
      } catch {
        /* url rara: no es nuestra */
      }
    }
  }
  return found;
}

async function saveStatus(value) {
  await query('insert into ml_settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [
    'calendly',
    JSON.stringify(value),
  ]);
}

export async function calendlyStatus() {
  const [r] = await query("select value from ml_settings where key = 'calendly'");
  try {
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/calendly',
    auth: 'admin',
    handler: async () => ({ calendly: await calendlyStatus() }),
  },
  {
    method: 'POST',
    path: '/calendly/conectar',
    auth: 'admin',
    handler: async ({ req, body }) => {
      const token = cleanToken((await body()).token);
      const me = await whoAmI(token);
      const url = ourWebhookUrl(req);
      const host = new URL(url).host;
      // Si ya había una conexión de esta app (por ejemplo, con otra clave), se reemplaza.
      for (const s of await ourSubscriptions(token, me, host)) await cal(token, 'DELETE', s.uri);

      // Primero para toda la organización (todas las personas de la cuenta de Calendly);
      // si la cuenta no deja, solo para quien creó el token.
      let scope = 'organization';
      let r = await cal(token, 'POST', '/webhook_subscriptions', { url, events: EVENTS, organization: me.current_organization, scope });
      if (r.status === 403 || r.status === 401) {
        scope = 'user';
        r = await cal(token, 'POST', '/webhook_subscriptions', { url, events: EVENTS, organization: me.current_organization, user: me.uri, scope });
      }
      if (r.status === 403 || r.status === 401) {
        throw new HttpError(400, 'Tu cuenta de Calendly no permite conectar avisos automáticos (webhooks). Revisa tu plan de Calendly o usa la dirección para agendas con Zapier o n8n.');
      }
      if (r.status !== 201 && r.status !== 200) {
        const msg = r.json?.message || r.json?.title || `código ${r.status}`;
        throw new HttpError(502, `Calendly no creó la conexión: ${msg}`);
      }
      const status = {
        conectado: true,
        cuenta: me.email || '',
        nombre: me.name || '',
        alcance: scope,
        suscripcion: r.json?.resource?.uri || '',
        desde: new Date().toISOString(),
      };
      await saveStatus(status);
      return { calendly: status };
    },
  },
  {
    method: 'POST',
    path: '/calendly/desconectar',
    auth: 'admin',
    handler: async ({ req, body }) => {
      const token = cleanToken((await body()).token);
      const me = await whoAmI(token);
      const host = new URL(ourWebhookUrl(req)).host;
      const subs = await ourSubscriptions(token, me, host);
      for (const s of subs) await cal(token, 'DELETE', s.uri);
      await query("delete from ml_settings where key = 'calendly'");
      return { ok: true, borradas: subs.length };
    },
  },
];
