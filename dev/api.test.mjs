// Núcleo y Ventas contra un Postgres en memoria.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, jar, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

test('alta, sesión, permisos y ManyChat', async () => {
  let r = await api('GET', '/status');
  assert.deepEqual(r.json, { connected: true, needsAdmin: true });
  assert.equal((await api('GET', '/auth/me', { cookie: '' })).status, 401);

  r = await api('POST', '/setup', { body: { nombre: 'Ana', email: ' Ana@Test.com ', password: 'corta' } });
  assert.equal(r.status, 400);
  r = await api('POST', '/setup', {
    body: { nombre: 'Ana', email: ' Ana@Test.com ', password: 'clave-larga-1', negocio: ' Estudio Ana ', zona: 'America/Bogota' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.user.roles, ['admin']);
  r = await api('GET', '/ajustes');
  assert.equal(r.json.negocio, 'Estudio Ana', 'el primer arranque guarda el nombre del negocio');
  assert.equal(r.json.zona, 'America/Bogota', 'y la zona horaria del navegador');
  assert.equal((await api('POST', '/setup', { body: { nombre: 'X', email: 'x@t.com', password: 'clave-larga-2' } })).status, 409);

  assert.equal((await api('POST', '/auth/login', { body: { email: 'ana@test.com', password: 'mala' }, cookie: '' })).status, 401);
  r = await api('POST', '/auth/login', { body: { email: 'ANA@test.com', password: 'clave-larga-1' }, cookie: '' });
  assert.equal(r.status, 200);

  // cookie alterada
  assert.equal((await api('GET', '/ventas', { cookie: jar.cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) })).status, 401);

  // ManyChat
  r = await api('GET', '/settings');
  const secret = r.json.manychatSecret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal((await api('POST', '/webhooks/manychat', { headers: { 'x-webhook-secret': 'mala' }, body: { eventType: 'link_sent', contactId: '1' } })).status, 401);
  assert.equal((await api('POST', '/webhooks/manychat', { headers: { 'x-webhook-secret': secret }, body: { eventType: 'otro', contactId: '1' } })).status, 400);
  r = await api('POST', '/webhooks/manychat', { headers: { 'x-webhook-secret': secret }, body: { eventType: 'content_reply', contactId: '123', contentCode: 'P - X - 01/12/2026' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.matched, false);
  r = await api('GET', '/events?sinMatch=1');
  assert.equal(r.json.events.length, 1);

  // 404 y 405
  assert.equal((await api('GET', '/no-existe')).status, 404);
  assert.equal((await api('DELETE', '/status')).status, 405);
});

test('usuarios: crear, roles y permisos', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  const setter = await userSession({ nombre: 'Nacho', email: 'nacho@test.com', roles: ['setter'] });
  assert.ok(setter.cookie);
  assert.equal((await api('GET', '/usuarios', { cookie: setter.cookie })).status, 403);
  assert.equal((await api('POST', '/usuarios', { body: { nombre: 'Dup', email: 'nacho@test.com', roles: ['setter'], password: 'clave-larga-3' } })).status, 409);
  const r = await api('GET', '/usuarios');
  assert.equal(r.json.usuarios.length, 2);
});

test('ventas: crear, mover, estatus, notas y resultado venta → cliente', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  let r = await api('GET', '/ventas');
  assert.equal(r.status, 200);
  const etapas = r.json.etapas;
  const byTipo = (t) => etapas.find((e) => e.tipo === t);
  const agendas = etapas.find((e) => e.nombre === 'Agendas');

  r = await api('POST', '/ventas', { body: { nombre: 'Lead 1', telefono: '+51 999', setter_id: 'no-uuid', fecha_llamada: '2030-12-01T15:00:00.000Z' } });
  assert.equal(r.status, 200);
  const v = r.json.venta;
  assert.equal(v.etapa_id, byTipo('entrada').id);
  assert.equal(v.setter_id, '');
  assert.equal(v.status, 'para_hoy');

  r = await api('POST', `/ventas/${v.id}/mover`, { body: { etapaId: agendas.id } });
  assert.equal(r.json.venta.etapa_id, agendas.id);

  r = await api('POST', `/ventas/${v.id}/estatus`, { body: { status: 'standby' } });
  assert.equal(r.status, 400);
  r = await api('POST', `/ventas/${v.id}/estatus`, { body: { status: 'standby', proximaAccion: '2031-01-01T10:00:00Z' } });
  assert.equal(r.json.venta.status, 'standby');

  r = await api('POST', `/ventas/${v.id}/notas`, { body: { texto: 'Llamar a las 5' } });
  assert.equal(r.status, 200);

  // venta sin monto → 400
  r = await api('PUT', `/ventas/${v.id}/resultado`, { body: { resultado: 'venta', programa: '3 meses' } });
  assert.equal(r.status, 400);
  r = await api('PUT', `/ventas/${v.id}/resultado`, { body: { resultado: 'venta', programa: '3 meses', meses: 3, montoTotal: 900, pagoInicial: 300, metodoPago: 'Transferencia' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.clienteId);
  assert.equal(r.json.venta.status, 'ganado');
  assert.equal(r.json.venta.etapa_id, byTipo('ganado').id);

  // corregir el resultado no duplica el cliente
  r = await api('PUT', `/ventas/${v.id}/resultado`, { body: { resultado: 'venta', programa: '6 meses', meses: 6, montoTotal: 1500, pagoInicial: 500 } });
  assert.equal(r.status, 200);
  r = await api('GET', `/ventas/${v.id}`);
  assert.equal(r.json.notas.length, 1);
  assert.equal(r.json.resultado.programa, '6 meses');
  assert.ok(r.json.cliente);

  // Llamada pasada sin resultado no puede ir a Perdido
  r = await api('POST', '/ventas', { body: { nombre: 'Lead 2', fecha_llamada: '2020-01-01T10:00:00Z' } });
  const v2 = r.json.venta;
  r = await api('POST', `/ventas/${v2.id}/mover`, { body: { etapaId: byTipo('perdido').id } });
  assert.equal(r.status, 409);

  // setter solo puede cancelar
  const setter = await userSession({ nombre: 'Edu', email: 'edu@test.com', roles: ['setter'] });
  r = await api('PUT', `/ventas/${v2.id}/resultado`, { cookie: setter.cookie, body: { resultado: 'venta', programa: 'x', montoTotal: 1, pagoInicial: 1 } });
  assert.equal(r.status, 403);
  r = await api('PUT', `/ventas/${v2.id}/resultado`, { cookie: setter.cookie, body: { resultado: 'cancelada' } });
  assert.equal(r.status, 400, 'cancelada exige motivo');
  r = await api('PUT', `/ventas/${v2.id}/resultado`, { cookie: setter.cookie, body: { resultado: 'cancelada', motivo: 'No califica' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.venta.status, 'cancelado');

  // columna con agendas no se borra
  r = await api('DELETE', `/etapas/${byTipo('ganado').id}`);
  assert.equal(r.status, 409);
});

test('un usuario desactivado pierde el acceso al recargar', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  const closer = await userSession({ nombre: 'Lucía', email: 'lucia@test.com', roles: ['closer'] });
  assert.equal((await api('GET', '/ventas', { cookie: closer.cookie })).status, 200);
  await api('PATCH', `/usuarios/${closer.id}`, { body: { activo: false } });
  assert.equal((await api('GET', '/ventas', { cookie: closer.cookie })).status, 401);
});

test('login: 5 intentos fallidos frenan 15 minutos', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/auth/login', { body: { email: 'freno@test.com', password: 'mala' }, cookie: '' });
    assert.equal(r.status, 401);
  }
  const r = await api('POST', '/auth/login', { body: { email: 'freno@test.com', password: 'mala' }, cookie: '' });
  assert.equal(r.status, 429);
});

test('webhook de agenda: formato simple, Calendly e idempotencia', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  const k = (await api('GET', '/settings')).json.manychatSecret;
  assert.equal((await api('POST', '/webhooks/agenda', { body: { nombre: 'X' }, headers: { 'x-webhook-secret': 'mala' } })).status, 401);
  let r = await api('POST', `/webhooks/agenda?k=${k}`, { body: { nombre: 'Lead Web', telefono: '+51 900', contactId: '777', fechaLlamada: '2031-02-01T15:00:00Z', presupuesto: 'con', ref: 'form-1' } });
  assert.equal(r.status, 200);
  const id = r.json.id;
  r = await api('POST', `/webhooks/agenda?k=${k}`, { body: { nombre: 'Lead Web', ref: 'form-1' } });
  assert.equal(r.json.duplicada, true);
  assert.equal(r.json.id, id);
  r = await api('POST', '/webhooks/agenda', {
    headers: { 'x-webhook-secret': k },
    body: {
      event: 'invitee.created',
      payload: {
        uri: 'https://api.calendly.com/scheduled_events/A/invitees/B',
        name: 'Carla Calendly',
        email: 'Carla@Mail.com',
        tracking: { utm_content: '555' },
        questions_and_answers: [{ question: '¿Cuál es tu celular?', answer: '+52 55 1234' }, { question: 'Tu Instagram', answer: '@carla' }],
        scheduled_event: { start_time: '2031-03-01T18:00:00Z', event_memberships: [{ user_email: 'ana@test.com' }] },
      },
    },
  });
  assert.equal(r.status, 200);
  const v = (await api('GET', `/ventas/${r.json.id}`)).json.venta;
  assert.equal(v.nombre, 'Carla Calendly');
  assert.equal(v.email, 'carla@mail.com');
  assert.equal(v.contact_id, '555');
  assert.equal(v.telefono, '+52 55 1234');
  assert.equal(v.instagram, 'carla');
  assert.equal(v.origen, 'calendly');
  assert.ok(v.closer_id, 'closer por email');
});
