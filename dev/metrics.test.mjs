// Fórmulas de métricas (api/_lib/metrics.js) con datos armados a mano.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

test('agendas, show rate, close rate, ventas, cash y propuestas por setter', async () => {
  await adminSession();
  const setter = await userSession({ nombre: 'Nacho', email: 'nacho@test.com', roles: ['setter'] });
  const closer = await userSession({ nombre: 'Ana', email: 'ana@test.com', roles: ['closer'] });
  const { metrics } = await import('../api/_lib/metrics.js');
  const { query } = await import('../api/_lib/db.js');

  const hoy = new Date();
  const ayer = new Date(Date.now() - 86_400_000).toISOString();
  const mk = async (nombre, extra = {}) =>
    (await api('POST', '/ventas', { body: { nombre, setter_id: setter.id, closer_id: closer.id, contact_id: nombre, fecha_llamada: ayer, ...extra } })).json.venta;

  const a = await mk('A'); // venta
  const b = await mk('B'); // no show
  const c = await mk('C'); // no cerró
  const d = await mk('D'); // cancelada
  await mk('E'); // sin resultado
  await api('PUT', `/ventas/${a.id}/resultado`, { body: { resultado: 'venta', programa: '3 meses', meses: 3, montoTotal: 900, pagoInicial: 300 } });
  await api('PUT', `/ventas/${b.id}/resultado`, { body: { resultado: 'no_show' } });
  await api('PUT', `/ventas/${c.id}/resultado`, { body: { resultado: 'no_cerro', motivo: 'precio' } });
  await api('PUT', `/ventas/${d.id}/resultado`, { body: { resultado: 'cancelada', motivo: 'no califica' } });

  // ManyChat: 2 propuestas del mismo contacto el mismo día = 1; 1 link
  const s = (await api('GET', '/settings')).json.manychatSecret;
  const hook = (body) => api('POST', '/webhooks/manychat', { headers: { 'x-webhook-secret': s }, body: { setterEmail: 'nacho@test.com', ...body } });
  await hook({ eventType: 'call_proposed', contactId: 'X1' });
  await hook({ eventType: 'call_proposed', contactId: 'X1' });
  await hook({ eventType: 'link_sent', contactId: 'X1' });

  const range = { from: new Date(Date.now() - 3 * 86_400_000).toISOString(), to: new Date(hoy.getTime() + 86_400_000).toISOString() };
  const g = await metrics(range);
  assert.equal(g.agendas, 5);
  assert.equal(g.calificadas, 4);
  assert.equal(g.canceladas, 1);
  assert.equal(g.llamadas, 4, 'sin la cancelada');
  assert.equal(g.shows, 2);
  assert.equal(g.noShows, 1);
  assert.equal(g.sinResultado, 1);
  assert.equal(g.showRate, 50);
  assert.equal(g.ventas, 1);
  assert.equal(g.closeRate, 50);
  assert.equal(g.cash, 300);
  assert.equal(g.facturacion, 900);
  assert.equal(g.aov, 300);
  assert.equal(g.propuestas, 1);
  assert.equal(g.links, 1);

  const ps = await metrics(range, { setterId: setter.id });
  assert.equal(ps.agendas, 5);
  assert.equal(ps.cash, 300);
  assert.equal(ps.propuestas, 1);
  const pc = await metrics(range, { closerId: closer.id });
  assert.equal(pc.ventas, 1);
  assert.equal(pc.propuestas, 0);

  // Renovación: suma al global pero no al setter
  const [cl] = await query('select id from ml_clientes limit 1');
  const [ren] = await query("insert into ml_renovaciones (cliente_id, programa, meses, monto_total) values ($1, '3 meses', 3, 500) returning id", [cl.id]);
  await query('insert into ml_pagos (cliente_id, renovacion_id, monto) values ($1, $2, 500)', [cl.id, ren.id]);
  const g2 = await metrics(range);
  assert.equal(g2.cash, 800);
  assert.equal(g2.cashRenovaciones, 500);
  assert.equal(g2.facturacion, 1400);
  const ps2 = await metrics(range, { setterId: setter.id });
  assert.equal(ps2.cash, 300);
});
