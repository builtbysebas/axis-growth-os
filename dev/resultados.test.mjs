// Resultados de contenido y atribución con datos armados a mano.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const dayStr = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

test('resultados: atribución manual > automática, último antes de agendar, leads distintos, ROAS, huecos y permisos', async () => {
  await adminSession();
  const setter = await userSession({ nombre: 'Nacho', email: 'nacho@test.com', roles: ['setter'] });
  const closer = await userSession({ nombre: 'Ana', email: 'ana@test.com', roles: ['closer'] });
  const { query } = await import('../api/_lib/db.js');

  const [ang] = await query("insert into ml_angulos (nombre) values ('Hormonas') returning id");
  const mkC = async (kind, codigo, extra = {}) => {
    const [r] = await query(
      `insert into ml_contenido (kind, titulo, codigo, fecha, formato, tipo_story, angulo_id, gasto)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [kind, `Título ${codigo}`, codigo, extra.fecha ?? dayStr(5), extra.formato ?? '', extra.tipo_story ?? '', extra.angulo_id ?? null, extra.gasto ?? null],
    );
    return r.id;
  };
  const P1 = await mkC('post', 'P - UNO', { formato: 'Reel', angulo_id: ang.id });
  const P2 = await mkC('post', 'P - DOS');
  const S1 = await mkC('story', 'S - TRES', { angulo_id: ang.id });
  const A1 = await mkC('ad', 'A - CUATRO', { gasto: 100, angulo_id: ang.id });
  const OLD = await mkC('post', 'P - VIEJO', { fecha: dayStr(60), formato: 'Reel', angulo_id: ang.id });

  const reply = (contact, contenido, when) =>
    query("insert into ml_eventos (tipo, contact_id, codigo, contenido_id, recibido) values ('content_reply', $1, 'x', $2, $3)", [contact, contenido, when]);
  const mkV = async (nombre, contact, extra = {}) => {
    const [r] = await query(
      `insert into ml_ventas (nombre, contact_id, agendada, fecha_llamada, setter_id, closer_id, status, atrib_contenido_id, atrib_motivo, presupuesto)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [nombre, contact, extra.agendada ?? ago(2), extra.fecha_llamada ?? ago(1), setter.id, closer.id, extra.status ?? 'para_hoy', extra.atrib ?? null, extra.motivo ?? '', extra.presupuesto ?? ''],
    );
    return r.id;
  };
  const sale = async (ventaId, total, pagos) => {
    await query("insert into ml_resultados (venta_id, resultado, monto_total, creado) values ($1, 'venta', $2, $3)", [ventaId, total, ago(1)]);
    const [cl] = await query('insert into ml_clientes (venta_id, nombre) values ($1, $2) returning id', [ventaId, 'Cliente']);
    for (const [monto, when, renov] of pagos) {
      let renId = null;
      if (renov) [{ id: renId }] = await query("insert into ml_renovaciones (cliente_id, monto_total) values ($1, $2) returning id", [cl.id, monto]);
      await query('insert into ml_pagos (cliente_id, monto, pagado, renovacion_id) values ($1, $2, $3, $4)', [cl.id, monto, when, renId]);
    }
  };

  // L1: respondió P1 y luego P2 antes de agendar; A1 después de agendar (no cuenta). Venta.
  await reply('L1', P1, ago(5));
  await reply('L1', P2, ago(3));
  await reply('L1', A1, ago(1.5));
  const v1 = await mkV('Lead Uno', 'L1');
  await sale(v1, 900, [[300, ago(1)], [200, ago(0.5)], [500, ago(0.4), true]]);
  // L2: respondió P1, pero tiene atribución manual al anuncio A1. Venta pagada completa.
  await reply('L2', P1, ago(4));
  const v2 = await mkV('Lead Dos', 'L2', { atrib: A1 });
  await sale(v2, 1000, [[1000, ago(1)]]);
  // L3: respondió P1 dos veces (un solo lead), sin presupuesto, cancelada.
  await reply('L3', P1, ago(4));
  await reply('L3', P1, ago(3.5));
  const v3 = await mkV('Lead Tres', 'L3', { presupuesto: 'sin' });
  await query("insert into ml_resultados (venta_id, resultado) values ($1, 'cancelada')", [v3]);
  // L4: respondió P1, pero tiene un motivo manual («Bienvenida»): no cuenta para P1.
  await reply('L4', P1, ago(4));
  const v4 = await mkV('Lead Cuatro', 'L4', { motivo: 'Bienvenida' });
  await query("insert into ml_resultados (venta_id, resultado) values ($1, 'no_show')", [v4]);
  // L5: sin ningún contenido, llamada futura.
  const v5 = await mkV('Lead Cinco', 'L5', { fecha_llamada: new Date(Date.now() + 3 * DAY).toISOString() });
  // Respuesta a un contenido viejo (fuera del rango de fechas del contenido).
  await reply('L9', OLD, ago(1));

  const range = { from: dayStr(30), to: dayStr(-1) };

  // ---------------------------------------------------------------- permisos y validación
  assert.equal((await api('GET', `/resultados?from=${range.from}&to=${range.to}`, { cookie: setter.cookie })).status, 403);
  assert.equal((await api('GET', `/resultados/atribucion?from=${range.from}&to=${range.to}`, { cookie: closer.cookie })).status, 403);
  assert.equal((await api('GET', '/resultados/huecos', { cookie: setter.cookie })).status, 403);
  assert.equal((await api('GET', '/resultados/huecos', { cookie: '' })).status, 401);
  assert.equal((await api('GET', '/resultados')).status, 400);
  assert.equal((await api('GET', '/resultados/atribucion?from=x&to=y')).status, 400);

  // ---------------------------------------------------------------- resultados (todo)
  let r = await api('GET', `/resultados?from=${range.from}&to=${range.to}`);
  assert.equal(r.status, 200);
  const by = (codigo) => r.json.items.find((i) => i.codigo === codigo);
  assert.equal(r.json.items.length, 4, 'el contenido viejo queda fuera del rango');
  assert.equal(by('P - UNO').leads, 4, 'leads = contactos distintos');
  assert.equal(by('P - UNO').agendas, 1, 'solo L3: L2 es manual a A1 y L4 tiene motivo');
  assert.equal(by('P - UNO').canceladas, 1);
  assert.equal(by('P - UNO').sinPresupuesto, 1);
  assert.equal(by('P - UNO').shows, 0);
  assert.equal(by('P - UNO').llamadas, 0, 'la cancelada no es llamada debida');
  assert.equal(by('P - DOS').agendas, 1, 'último contenido ANTES de agendar');
  assert.equal(by('P - DOS').shows, 1);
  assert.equal(by('P - DOS').ventas, 1);
  assert.equal(by('P - DOS').cash, 500, 'pagos de la venta sin la renovación');
  assert.equal(by('A - CUATRO').agendas, 1, 'la manual gana a la automática');
  assert.equal(by('A - CUATRO').leads, 1, 'L1 respondió después de agendar: es lead, no agenda');
  assert.equal(by('A - CUATRO').ventas, 1);
  assert.equal(by('A - CUATRO').cash, 1000);
  assert.equal(by('A - CUATRO').gasto, 100);
  assert.equal(r.json.totals.ventas, 2);
  assert.equal(r.json.totals.cash, 1500);
  assert.equal(r.json.totals.leadsPersonas, 4);
  assert.equal(r.json.totals.roas, null, 'ROAS solo en Ads');
  // Contenidos antes de comprar: L1 tocó P1, P2 y A1 antes de su primer pago (3); L2 solo P1 (1).
  assert.equal(r.json.antesDeComprar.ventas, 2);
  assert.equal(r.json.antesDeComprar.promedio, 2);

  // ---------------------------------------------------------------- solo Ads: ROAS y costo por lead
  r = await api('GET', `/resultados?from=${range.from}&to=${range.to}&kind=ad`);
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.totals.gasto, 100);
  assert.equal(r.json.totals.roas, 10);
  assert.equal(r.json.totals.costoPorLead, 100);
  r = await api('GET', `/resultados?from=${range.from}&to=${range.to}&kind=nada`);
  assert.equal(r.json.kind, '', 'tipo inválido = todo');
  assert.equal(r.json.items.length, 4);

  // ---------------------------------------------------------------- atribución
  r = await api('GET', `/resultados/atribucion?scope=agendas&from=${range.from}&to=${range.to}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.counts.total, r.json.counts.auto, r.json.counts.manual, r.json.counts.ninguna], [5, 2, 2, 1]);
  const row = (id) => r.json.rows.find((x) => x.id === id);
  assert.equal(row(v1).origen, 'auto');
  assert.equal(row(v1).contenido.codigo, 'P - DOS');
  assert.equal(row(v2).origen, 'manual_contenido');
  assert.equal(row(v2).contenido.id, A1);
  assert.equal(row(v4).origen, 'manual_motivo');
  assert.equal(row(v4).motivo, 'Bienvenida');
  assert.equal(row(v4).contenido, null);
  assert.equal(row(v5).origen, 'ninguna');
  assert.equal(row(v1).setter, 'Nacho');
  assert.equal(row(v1).closer, 'Ana');
  assert.equal(row(v3).resultado, 'cancelada');

  r = await api('GET', `/resultados/atribucion?scope=agendas&from=${range.from}&to=${range.to}&sinAtribucion=1`);
  assert.equal(r.json.rows.length, 1);
  assert.equal(r.json.rows[0].id, v5);
  assert.equal(r.json.counts.total, 5, 'los conteos son de todo el rango');

  r = await api('GET', `/resultados/atribucion?scope=ventas&from=${range.from}&to=${range.to}`);
  assert.equal(r.json.rows.length, 2);
  assert.equal(r.json.rows.find((x) => x.id === v1).cash, 500);
  assert.equal(r.json.rows.find((x) => x.id === v1).pagoInicial, 300);
  assert.equal(r.json.rows.find((x) => x.id === v2).montoTotal, 1000);
  assert.equal(r.json.counts.cash, 1500);
  assert.equal(r.json.counts.ticket, 1900);

  // Editar la atribución con la ruta de Ventas: asignar a L5 y quitar la manual de L2.
  assert.equal((await api('PATCH', `/ventas/${v5}/atribucion`, { body: { contenidoId: P1 }, cookie: setter.cookie })).status, 403);
  await api('PATCH', `/ventas/${v5}/atribucion`, { body: { contenidoId: P1 } });
  await api('PATCH', `/ventas/${v2}/atribucion`, { body: {} });
  r = await api('GET', `/resultados/atribucion?scope=agendas&from=${range.from}&to=${range.to}`);
  assert.equal(row(v5).origen, 'manual_contenido');
  assert.equal(row(v2).origen, 'auto', 'sin manual vuelve a la automática');
  assert.equal(row(v2).contenido.id, P1);
  r = await api('GET', `/resultados?from=${range.from}&to=${range.to}`);
  assert.equal(r.json.items.find((i) => i.codigo === 'P - UNO').agendas, 3, 'L3 + L5 (manual) + L2 (automática)');
  assert.equal(r.json.items.find((i) => i.codigo === 'A - CUATRO').agendas, 0);

  // ---------------------------------------------------------------- huecos
  r = await api('GET', '/resultados/huecos');
  assert.equal(r.status, 200);
  const codes = r.json.items.map((i) => i.codigo);
  assert.deepEqual(new Set(codes), new Set(['P - DOS', 'S - TRES']), 'P2 sin ángulo ni formato, S1 sin tipo; A1 y los demás completos');
  assert.equal(r.json.items.find((i) => i.codigo === 'P - DOS').leads, 1);
  assert.equal(r.json.totalLeads, 4 + 1 + 1 + 1, 'P1 4 + P2 1 + A1 1 + viejo 1');
  assert.equal(r.json.angulos.length, 1);
  assert.deepEqual(r.json.formatos, ['Reel']);
  assert.equal(r.json.leadsPorKind.post, 6);
  void S1;
});
