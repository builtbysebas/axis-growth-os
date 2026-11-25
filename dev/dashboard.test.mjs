// Dashboard: totales, cash y agendas por fuente, detalle de pagos, equipo con EOD y permisos.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

function rangeQs() {
  const d = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 10);
  return `from=${d(-5 * 86_400_000)}&to=${d(2 * 86_400_000)}`;
}

test('dashboard: general, fuentes, detalle de pagos, equipo y permisos', async () => {
  await adminSession();
  const setter = await userSession({ nombre: 'Nacho Setter', email: 'nacho@test.com', roles: ['setter'] });
  const setter2 = await userSession({ nombre: 'Edu Setter', email: 'edu@test.com', roles: ['setter'] });
  const closer = await userSession({ nombre: 'Ana Closer', email: 'ana@test.com', roles: ['closer'] });
  const coach = await userSession({ nombre: 'Fabi Coach', email: 'fabi@test.com', roles: ['coach'] });
  const { query } = await import('../api/_lib/db.js');
  const Q = rangeQs();

  // Permisos: solo admin.
  for (const path of [`/dashboard?${Q}`, `/dashboard/cash?${Q}`, `/dashboard/fuentes?${Q}`, `/dashboard/equipo?rol=setter&${Q}`]) {
    assert.equal((await api('GET', path, { cookie: setter.cookie })).status, 403, path);
    assert.equal((await api('GET', path, { cookie: closer.cookie })).status, 403, path);
    assert.equal((await api('GET', path, { cookie: '' })).status, 401, path);
  }
  // Validaciones
  assert.equal((await api('GET', '/dashboard')).status, 400, 'sin rango');
  assert.equal((await api('GET', '/dashboard?from=hola&to=2026-01-01')).status, 400);
  assert.equal((await api('GET', `/dashboard/equipo?rol=coach&${Q}`)).status, 400);

  // Vacío
  let r = await api('GET', `/dashboard?${Q}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.metrics.cash, 0);
  assert.deepEqual(r.json.fuentes.cash, { total: 0, sources: [] });
  assert.deepEqual(r.json.fuentes.agendas, { total: 0, sources: [] });

  // Contenido: una historia (CTA) y un post (Reel).
  const [story] = await query(
    "insert into ml_contenido (kind, titulo, codigo, tipo_story) values ('story', 'Historia receta', 'S - RECETA - 01/11/2026', 'CTA') returning id",
  );
  await query("insert into ml_contenido (kind, titulo, codigo, formato) values ('post', 'Reel hormonas', 'P - HORMONAS - 01/11/2026', 'Reel')");

  // ManyChat: A respondió la historia antes de agendar; B respondió el reel.
  const secret = (await api('GET', '/settings')).json.manychatSecret;
  const hook = (body) => api('POST', '/webhooks/manychat', { headers: { 'x-webhook-secret': secret }, body });
  assert.equal((await hook({ eventType: 'content_reply', contactId: 'A', contentCode: 's - receta - 01/11/2026' })).json.matched, true);
  await hook({ eventType: 'content_reply', contactId: 'B', contentCode: 'P - HORMONAS - 01/11/2026' });
  await hook({ eventType: 'call_proposed', contactId: 'A', setterEmail: 'nacho@test.com' });
  await hook({ eventType: 'link_sent', contactId: 'A', setterEmail: 'nacho@test.com' });

  const ayer = new Date(Date.now() - 86_400_000).toISOString();
  const mk = async (nombre, extra = {}) =>
    (
      await api('POST', '/ventas', {
        body: { nombre, setter_id: setter.id, closer_id: closer.id, fecha_llamada: ayer, presupuesto: 'con', ...extra },
      })
    ).json.venta;

  const a = await mk('Lead A', { contact_id: 'A' }); // venta: 900 total, 300 inicial → story CTA
  const b = await mk('Lead B', { contact_id: 'B' }); // venta: 500 / 500 → post Reel
  const c = await mk('Lead C', { setter_id: setter2.id }); // venta con motivo manual «bienvenida»
  const d = await mk('Lead D', { presupuesto: 'sin' }); // no show
  const e = await mk('Lead E'); // cancelada (no cuenta en agendas con presupuesto)
  await mk('Lead F'); // sin resultado, con presupuesto, sin atribución

  const res = (v, body) => api('PUT', `/ventas/${v.id}/resultado`, { body });
  assert.equal((await res(a, { resultado: 'venta', programa: '3 meses', meses: 3, montoTotal: 900, pagoInicial: 300, metodoPago: 'Transferencia' })).status, 200);
  assert.equal((await res(b, { resultado: 'venta', programa: '1 mes', meses: 1, montoTotal: 500, pagoInicial: 500 })).status, 200);
  assert.equal((await res(c, { resultado: 'venta', programa: '6 meses', meses: 6, montoTotal: 1200, pagoInicial: 200, metodoPago: 'PayPal' })).status, 200);
  await res(d, { resultado: 'no_show' });
  await res(e, { resultado: 'cancelada', motivo: 'no califica' });
  assert.equal((await api('PATCH', `/ventas/${c.id}/atribucion`, { body: { motivo: '  bienvenida ' } })).status, 200);

  // Cuota del cliente A y renovación del cliente B (con coach).
  const [clA] = await query('select id from ml_clientes where venta_id = $1', [a.id]);
  const [clB] = await query('select id from ml_clientes where venta_id = $1', [b.id]);
  await query("update ml_clientes set coach_id = $2 where id = $1", [clB.id, coach.id]);
  await query("insert into ml_pagos (cliente_id, monto, pagado, metodo) values ($1, 150, now() + interval '1 minute', 'Yape')", [clA.id]);
  const [ren] = await query("insert into ml_renovaciones (cliente_id, programa, meses, monto_total) values ($1, '3 meses', 3, 400) returning id", [clB.id]);
  await query("insert into ml_pagos (cliente_id, renovacion_id, monto, pagado) values ($1, $2, 400, now() + interval '2 minutes')", [clB.id, ren.id]);
  // Pago fuera del rango: no cuenta.
  await query("insert into ml_pagos (cliente_id, monto, pagado) values ($1, 999, now() + interval '60 days')", [clA.id]);

  // ---------------------------------------------------------------- General
  r = await api('GET', `/dashboard?${Q}`);
  assert.equal(r.status, 200);
  const m = r.json.metrics;
  assert.equal(m.agendas, 6);
  assert.equal(m.calificadas, 5);
  assert.equal(m.ventas, 3);
  assert.equal(m.cash, 300 + 500 + 200 + 150 + 400);
  assert.equal(m.cashRenovaciones, 400);
  assert.equal(m.sinResultado, 1);
  assert.equal(m.propuestas, 1);
  assert.equal(m.links, 1);
  assert.equal(m.conPresupuesto, 5);
  assert.equal(m.sinPresupuesto, 1);

  // Cash por fuente
  const cash = r.json.fuentes.cash;
  assert.equal(cash.total, 1550, 'suma igual al cash collected');
  const byKey = Object.fromEntries(cash.sources.map((s) => [s.key, s]));
  assert.equal(byKey['story:cta'].label, 'Story · CTA');
  assert.equal(byKey['story:cta'].value, 450, 'venta + cuota de A');
  assert.equal(byKey['story:cta'].ventas, 1);
  assert.equal(byKey['story:cta'].pagos, 2);
  assert.deepEqual(byKey['story:cta'].top, [{ title: 'Historia receta', value: 450 }]);
  assert.equal(byKey['post:reel'].label, 'Contenido corto · Reel');
  assert.equal(byKey['post:reel'].value, 500);
  assert.equal(byKey['manual:bienvenida'].label, 'Bienvenida');
  assert.equal(byKey['manual:bienvenida'].group, 'manual');
  assert.equal(byKey.renewal.value, 400);
  assert.equal(byKey.renewal.ventas, 0);
  assert.equal(cash.sources[0].key, 'post:reel', 'ordenado de mayor a menor');

  // Agendas con presupuesto por fuente (sin la cancelada ni la «sin presupuesto»)
  const ag = r.json.fuentes.agendas;
  assert.equal(ag.total, 4);
  const agKey = Object.fromEntries(ag.sources.map((s) => [s.key, s]));
  assert.equal(agKey['story:cta'].value, 1);
  assert.equal(agKey['story:cta'].ventas, 1);
  assert.equal(agKey['post:reel'].value, 1);
  assert.equal(agKey['manual:bienvenida'].value, 1);
  assert.equal(agKey.none.value, 1);
  assert.equal(agKey.none.ventas, 0);
  assert.deepEqual((await api('GET', `/dashboard/fuentes?${Q}`)).json, r.json.fuentes);

  // Atribución manual a contenido gana sobre la automática.
  await api('PATCH', `/ventas/${b.id}/atribucion`, { body: { contenidoId: story.id } });
  r = await api('GET', `/dashboard/fuentes?${Q}`);
  assert.equal(r.json.cash.sources.find((s) => s.key === 'story:cta').value, 950);
  assert.equal(r.json.cash.sources.find((s) => s.key === 'post:reel'), undefined);

  // ---------------------------------------------------------------- Detalle de pagos
  r = await api('GET', `/dashboard/cash?${Q}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.pagos.length, 5);
  assert.deepEqual(r.json.totales, { total: 1550, venta_nueva: 1000, cuota: 150, renovacion: 400 });
  const cuota = r.json.pagos.find((p) => p.tipo === 'cuota');
  assert.equal(cuota.cliente, 'Lead A');
  assert.equal(cuota.monto, 150);
  assert.equal(cuota.metodo, 'Yape');
  assert.equal(cuota.setter, 'Nacho Setter');
  assert.equal(cuota.closer, 'Ana Closer');
  const renov = r.json.pagos.find((p) => p.tipo === 'renovacion');
  assert.equal(renov.coach, 'Fabi Coach');
  const inicialA = r.json.pagos.find((p) => p.cliente === 'Lead A' && p.tipo === 'venta_nueva');
  assert.equal(inicialA.monto, 300);
  assert.equal(inicialA.metodo, 'Transferencia');
  assert.ok(new Date(r.json.pagos[0].fecha) >= new Date(r.json.pagos.at(-1).fecha), 'más nuevo primero');

  // ---------------------------------------------------------------- EOD de setters
  const preg = await query('select id, texto from ml_eod_preguntas');
  const id = (t) => preg.find((p) => p.texto === t).id;
  // Pregunta vieja desactivada con el mismo texto (con tilde y mayúsculas): también suma.
  const [old] = await query("insert into ml_eod_preguntas (texto, tipo, roles, activa) values ('  OUTBOUND ', 'numero', 'setter', false) returning id");
  const hoy = new Date().toISOString().slice(0, 10);
  const antier = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  await query('insert into ml_eod_envios (user_id, fecha, respuestas) values ($1, $2, $3), ($1, $4, $5)', [
    setter.id,
    hoy,
    JSON.stringify({ [id('Outbound')]: 40, [id('Respuestas a Outbound')]: '10', [id('Inbound')]: 5, [id('Follow ups')]: 'muchos' }),
    antier,
    JSON.stringify({ [id('Outbound')]: '20', [old.id]: 40, [id('Follow ups')]: '7,5' }),
  ]);
  // Fuera del rango: no suma.
  await query('insert into ml_eod_envios (user_id, fecha, respuestas) values ($1, $2, $3)', [setter.id, '2020-01-01', JSON.stringify({ [id('Outbound')]: 1000 })]);
  // Respuestas que no son un objeto no rompen nada.
  await query("insert into ml_eod_envios (user_id, fecha, respuestas) values ($1, $2, '[1,2]'::jsonb)", [setter2.id, hoy]);

  r = await api('GET', `/dashboard/equipo?rol=setter&${Q}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.filas.length, 2);
  const nacho = r.json.filas.find((f) => f.id === setter.id);
  assert.equal(nacho.nombre, 'Nacho Setter');
  assert.equal(nacho.outbound, 100);
  assert.equal(nacho.respOutbound, 10);
  assert.equal(nacho.inbound, 5);
  assert.equal(nacho.followUps, 7.5);
  assert.equal(nacho.pctRespOutbound, 10);
  assert.equal(nacho.nuevasConversaciones, 15);
  assert.equal(nacho.propuestas, 1);
  assert.equal(nacho.links, 1);
  assert.equal(nacho.agendas, 5);
  assert.equal(nacho.ventas, 2);
  assert.equal(nacho.cash, 300 + 500 + 150, 'sin renovaciones');
  const edu = r.json.filas.find((f) => f.id === setter2.id);
  assert.equal(edu.outbound, null);
  assert.equal(edu.nuevasConversaciones, null);
  assert.equal(edu.pctRespOutbound, null);
  assert.equal(edu.cash, 200);

  r = await api('GET', `/dashboard/equipo?rol=closer&${Q}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.filas.length, 1);
  const ana = r.json.filas[0];
  assert.equal(ana.nombre, 'Ana Closer');
  assert.equal(ana.ventas, 3);
  assert.equal(ana.cash, 1150);
  assert.equal(ana.facturacion, 2600);
  assert.equal(ana.outbound, undefined, 'closers sin EOD de setter');
});
