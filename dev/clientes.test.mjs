// Clientes contra un Postgres en memoria: alta desde una venta y a mano, pagos y
// saldo, renovaciones (vencimiento y cash de renovaciones), paso automático a
// «Renovar» una sola vez por fecha, columnas y permisos de coach.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

const TZ = 'America/Lima';
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

async function board() {
  const r = await api('GET', '/clientes');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const etapa = (t) => r.json.etapas.find((e) => e.tipo === t);
  return { ...r.json, etapa, byName: (n) => r.json.clientes.find((c) => c.nombre === n) };
}

let coachA;
let coachB;

test('cliente nace de una venta y también a mano; pagos y saldo', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  coachA = await userSession({ nombre: 'Fabi Coach', email: 'fabi@test.com', roles: ['coach'] });
  coachB = await userSession({ nombre: 'Lu Coach', email: 'lu@test.com', roles: ['coach'] });

  // Venta → cliente + pago inicial
  let r = await api('POST', '/ventas', { body: { nombre: 'Venta Uno', telefono: '+51 999 111 222', email: 'uno@test.com' } });
  const v = r.json.venta;
  r = await api('PUT', `/ventas/${v.id}/resultado`, {
    body: { resultado: 'venta', programa: '3 meses', meses: 3, montoTotal: 900, pagoInicial: 300, metodoPago: 'Transferencia' },
  });
  assert.equal(r.status, 200);
  const clienteId = r.json.clienteId;

  let b = await board();
  assert.equal(b.coaches.length, 2);
  assert.deepEqual(b.metodos.includes('Mercado Pago'), true);
  const c1 = b.clientes.find((c) => c.id === clienteId);
  assert.equal(c1.nombre, 'Venta Uno');
  assert.equal(c1.etapa_id, b.etapa('entrada').id);
  assert.equal(Number(c1.pagado), 300);
  assert.equal(Number(c1.saldo), 600);
  assert.equal(c1.renovaciones, 0);
  assert.match(c1.inicio, /^\d{4}-\d{2}-\d{2}$/);

  // Pagos: validaciones
  assert.equal((await api('POST', `/clientes/${clienteId}/pagos`, { body: { monto: 0, metodo: 'Transferencia' } })).status, 400);
  assert.equal((await api('POST', `/clientes/${clienteId}/pagos`, { body: { monto: 100 } })).status, 400, 'falta método');
  assert.equal((await api('POST', `/clientes/${clienteId}/pagos`, { body: { monto: 100, metodo: 'Bitcoin' } })).status, 400);
  assert.equal((await api('POST', `/clientes/${clienteId}/pagos`, { body: { monto: 100, metodo: 'PayPal', fecha: addDays(today(), 3) } })).status, 400, 'futuro');
  assert.equal((await api('POST', `/clientes/${clienteId}/pagos`, { body: { monto: 100, metodo: 'PayPal', fecha: '2026-02-31' } })).status, 400);

  r = await api('POST', `/clientes/${clienteId}/pagos`, { body: { monto: '250.50', metodo: 'PayPal', nota: 'Cuota 2', fecha: addDays(today(), -5) } });
  assert.equal(r.status, 200);
  assert.equal(Number(r.json.cliente.pagado), 550.5);
  assert.equal(Number(r.json.cliente.saldo), 349.5);
  const pagoId = r.json.pagoId;

  // Detalle
  r = await api('GET', `/clientes/${clienteId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.pagos.length, 2);
  const p2 = r.json.pagos.find((p) => p.id === pagoId);
  assert.equal(p2.fecha, addDays(today(), -5));
  assert.equal(p2.metodo, 'PayPal');
  assert.ok(r.json.venta);
  assert.equal(r.json.puedeEditar, true);

  // Editar la fecha de un pago
  r = await api('PATCH', `/cliente-pagos/${pagoId}`, { body: { fecha: addDays(today(), -10) } });
  assert.equal(r.status, 200);
  r = await api('GET', `/clientes/${clienteId}`);
  assert.equal(r.json.pagos.find((p) => p.id === pagoId).fecha, addDays(today(), -10));
  assert.equal((await api('PATCH', `/cliente-pagos/${pagoId}`, { body: { fecha: '' } })).status, 400);

  // Borrar pago: solo admin
  assert.equal((await api('DELETE', `/cliente-pagos/${pagoId}`, { cookie: coachA.cookie })).status, 403);
  r = await api('DELETE', `/cliente-pagos/${pagoId}`);
  assert.equal(r.status, 200);
  assert.equal(Number(r.json.cliente.pagado), 300);
  assert.equal((await api('DELETE', `/cliente-pagos/${pagoId}`)).status, 404);

  // A mano (admin): vence automático = inicio + meses, pago inicial opcional
  assert.equal((await api('POST', '/clientes', { body: { nombre: '' } })).status, 400);
  assert.equal((await api('POST', '/clientes', { cookie: coachA.cookie, body: { nombre: 'X' } })).status, 403);
  assert.equal((await api('POST', '/clientes', { body: { nombre: 'Y', pagoInicial: 100 } })).status, 400, 'pago sin método');
  assert.equal((await api('POST', '/clientes', { body: { nombre: 'Y', email: 'malo' } })).status, 400);
  r = await api('POST', '/clientes', {
    body: { nombre: 'Manual Dos', inicio: '2026-01-31', meses: 1, ticket: 500, coach_id: coachA.id, pagoInicial: 200, metodo: 'Efectivo' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = r.json.cliente;
  assert.equal(m.vence, '2026-02-28');
  assert.equal(m.coach_id, coachA.id);
  assert.equal(Number(m.pagado), 200);
  assert.equal(Number(m.saldo), 300);
  assert.equal(m.venta_id, '');

  // coach inexistente / sin rol coach
  assert.equal((await api('POST', '/clientes', { body: { nombre: 'Z', coach_id: m.id } })).status, 400);
});

test('renovación: mueve el vencimiento y suma a cash de renovaciones', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  const hoy = today();
  const futuro = addDays(hoy, 45);
  let r = await api('POST', '/clientes', { body: { nombre: 'Renueva Tres', programa: '3 meses', meses: 3, ticket: 900, inicio: addDays(hoy, -45), vence: futuro } });
  const id = r.json.cliente.id;

  assert.equal((await api('POST', `/clientes/${id}/renovaciones`, { body: { programa: '', meses: 3, montoTotal: 900 } })).status, 400);
  assert.equal((await api('POST', `/clientes/${id}/renovaciones`, { body: { programa: '6 meses', montoTotal: 900 } })).status, 400, 'faltan meses');
  assert.equal((await api('POST', `/clientes/${id}/renovaciones`, { body: { programa: '6 meses', meses: 6, montoTotal: 900, pagoInicial: 1000, metodo: 'PayPal' } })).status, 400);
  assert.equal((await api('POST', `/clientes/${id}/renovaciones`, { body: { programa: '6 meses', meses: 6, montoTotal: 900, pagoInicial: 100 } })).status, 400, 'falta método');

  // Vigente: sigue desde el vencimiento actual
  r = await api('POST', `/clientes/${id}/renovaciones`, { body: { programa: '6 meses', meses: 6, montoTotal: 1500, pagoInicial: 500, metodo: 'Mercado Pago' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cliente.vence, addMonths(futuro, 6));
  assert.equal(r.json.cliente.programa, '6 meses');
  assert.equal(r.json.cliente.renovaciones, 1);
  assert.equal(Number(r.json.cliente.pagado), 0, 'el pago de renovación no cuenta para el saldo de la venta');
  assert.equal(Number(r.json.cliente.pagado_renov), 500);
  assert.equal(Number(r.json.cliente.saldo), 900);

  r = await api('GET', `/clientes/${id}`);
  assert.equal(r.json.renovaciones.length, 1);
  assert.equal(Number(r.json.renovaciones[0].pagado), 500);
  assert.equal(r.json.renovaciones[0].inicio, futuro);
  const renovacionId = r.json.renovaciones[0].id;

  // Pago a cuenta de la renovación
  r = await api('POST', `/clientes/${id}/pagos`, { body: { monto: 300, metodo: 'Tarjeta', renovacionId } });
  assert.equal(r.status, 200);
  assert.equal(Number(r.json.cliente.pagado_renov), 800);
  assert.equal((await api('POST', `/clientes/${id}/pagos`, { body: { monto: 1, metodo: 'Tarjeta', renovacionId: '00000000-0000-0000-0000-000000000000' } })).status, 404);

  // Vencido: arranca hoy
  r = await api('POST', '/clientes', { body: { nombre: 'Vencida Cuatro', meses: 3, inicio: addDays(hoy, -120), vence: addDays(hoy, -30) } });
  const id2 = r.json.cliente.id;
  r = await api('POST', `/clientes/${id2}/renovaciones`, { body: { programa: '3 meses', meses: 3, montoTotal: 900 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.cliente.vence, addMonths(hoy, 3));

  // metrics(): renovaciones y cash de renovaciones del rango
  const { metrics } = await import('../api/_lib/metrics.js');
  const { dayRange } = await import('../api/_lib/util.js');
  const range = await dayRange({ from: hoy, to: hoy });
  const mt = await metrics(range);
  assert.equal(mt.cashRenovaciones, 800);
  assert.equal(mt.renovaciones, 2);
  assert.ok(mt.facturacion >= 1500 + 900);
});

test('paso automático a «Renovar», una sola vez por fecha', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  const hoy = today();
  let b = await board();
  const entrada = b.etapa('entrada');
  const renovar = b.etapa('renovar');
  const perdido = b.etapa('perdido');

  let r = await api('POST', '/clientes', { body: { nombre: 'Pronto Cinco', vence: addDays(hoy, 10) } });
  const id = r.json.cliente.id;
  r = await api('POST', '/clientes', { body: { nombre: 'Lejos Seis', vence: addDays(hoy, 40) } });
  r = await api('POST', '/clientes', { body: { nombre: 'Perdida Siete', vence: addDays(hoy, 5) } });
  const idP = r.json.cliente.id;
  await api('POST', `/clientes/${idP}/mover`, { body: { etapaId: perdido.id } });

  b = await board();
  assert.equal(b.byName('Pronto Cinco').etapa_id, renovar.id);
  assert.equal(b.byName('Lejos Seis').etapa_id, entrada.id);
  assert.equal(b.byName('Perdida Siete').etapa_id, perdido.id, 'Perdido nunca se mueve');

  // Si alguien lo saca de Renovar, se respeta
  r = await api('POST', `/clientes/${id}/mover`, { body: { etapaId: entrada.id } });
  assert.equal(r.json.cliente.etapa_id, entrada.id);
  b = await board();
  assert.equal(b.byName('Pronto Cinco').etapa_id, entrada.id);

  // Fecha de vencimiento nueva → vuelve a aplicar
  await api('PATCH', `/clientes/${id}`, { body: { vence: addDays(hoy, 15) } });
  b = await board();
  assert.equal(b.byName('Pronto Cinco').etapa_id, renovar.id);
});

test('kanban: mover, reordenar y columnas', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  let b = await board();
  const enProceso = b.etapas.find((e) => e.nombre === 'En proceso');
  const ids = [];
  for (const n of ['K1', 'K2', 'K3']) {
    const r = await api('POST', '/clientes', { body: { nombre: n } });
    ids.push(r.json.cliente.id);
    await api('POST', `/clientes/${r.json.cliente.id}/mover`, { body: { etapaId: enProceso.id } });
  }
  // K3 arriba de K1
  let r = await api('POST', `/clientes/${ids[2]}/mover`, { body: { etapaId: enProceso.id, beforeId: ids[0] } });
  assert.equal(r.status, 200);
  b = await board();
  let col = b.clientes.filter((c) => c.etapa_id === enProceso.id).map((c) => c.nombre);
  assert.deepEqual(col, ['K3', 'K1', 'K2']);
  // K2 entre K3 y K1
  await api('POST', `/clientes/${ids[1]}/mover`, { body: { etapaId: enProceso.id, beforeId: ids[0] } });
  b = await board();
  col = b.clientes.filter((c) => c.etapa_id === enProceso.id).map((c) => c.nombre);
  assert.deepEqual(col, ['K3', 'K2', 'K1']);
  assert.equal((await api('POST', `/clientes/${ids[0]}/mover`, { body: { etapaId: 'nope' } })).status, 404);

  // Columnas
  r = await api('POST', '/cliente-etapas', { body: { nombre: 'Pausa' } });
  assert.equal(r.status, 200);
  const pausa = r.json.etapas.find((e) => e.nombre === 'Pausa');
  assert.equal((await api('POST', '/cliente-etapas', { body: { nombre: ' ' } })).status, 400);
  r = await api('PATCH', `/cliente-etapas/${pausa.id}`, { body: { nombre: 'En pausa', tipo: 'renovar' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.etapas.filter((e) => e.tipo === 'renovar').length, 1, 'cada marca en una sola columna');
  assert.equal(r.json.etapas.find((e) => e.id === pausa.id).tipo, 'renovar');
  assert.equal((await api('PATCH', `/cliente-etapas/${pausa.id}`, { body: { tipo: 'ganado' } })).status, 400);
  // vuelve la marca a la columna original
  const original = b.etapas.find((e) => e.nombre === 'Renovar');
  await api('PATCH', `/cliente-etapas/${original.id}`, { body: { tipo: 'renovar' } });

  assert.equal((await api('DELETE', `/cliente-etapas/${enProceso.id}`)).status, 409, 'columna con clientes');
  r = await api('PUT', '/cliente-etapas/orden', { body: { ids: [pausa.id, ...b.etapas.map((e) => e.id)] } });
  assert.equal(r.json.etapas[0].id, pausa.id);
  assert.equal((await api('DELETE', `/cliente-etapas/${pausa.id}`)).status, 200);
});

test('permisos de coach', async () => {
  await adminSession('ana@test.com', 'clave-larga-1');
  let r = await api('POST', '/clientes', { body: { nombre: 'De Fabi', coach_id: coachA.id } });
  const suyo = r.json.cliente.id;
  r = await api('POST', '/clientes', { body: { nombre: 'De Lu', coach_id: coachB.id } });
  const ajeno = r.json.cliente.id;
  const b = await board();
  const otra = b.etapas.find((e) => e.nombre === 'En proceso');

  const ca = { cookie: coachA.cookie };
  // Ve todos
  r = await api('GET', '/clientes', ca);
  assert.equal(r.status, 200);
  assert.ok(r.json.clientes.some((c) => c.id === ajeno));
  r = await api('GET', `/clientes/${ajeno}`, ca);
  assert.equal(r.status, 200);
  assert.equal(r.json.puedeEditar, false);

  // Edita solo lo suyo
  assert.equal((await api('PATCH', `/clientes/${suyo}`, { ...ca, body: { telefono: '123' } })).status, 200);
  assert.equal((await api('PATCH', `/clientes/${ajeno}`, { ...ca, body: { telefono: '123' } })).status, 403);
  assert.equal((await api('PATCH', `/clientes/${suyo}`, { ...ca, body: { coach_id: coachB.id } })).status, 403, 'no cambia la coach');
  assert.equal((await api('PATCH', `/clientes/${suyo}`, { ...ca, body: { coach_id: coachA.id, nombre: 'De Fabi' } })).status, 200, 'misma coach = ok');
  assert.equal((await api('POST', `/clientes/${suyo}/pagos`, { ...ca, body: { monto: 50, metodo: 'Otro' } })).status, 200);
  assert.equal((await api('POST', `/clientes/${ajeno}/pagos`, { ...ca, body: { monto: 50, metodo: 'Otro' } })).status, 403);
  assert.equal((await api('POST', `/clientes/${suyo}/notas`, { ...ca, body: { texto: 'Hola' } })).status, 200);
  assert.equal((await api('POST', `/clientes/${suyo}/notas`, { ...ca, body: { texto: '  ' } })).status, 400);
  assert.equal((await api('POST', `/clientes/${ajeno}/notas`, { ...ca, body: { texto: 'Hola' } })).status, 403);
  assert.equal((await api('POST', `/clientes/${suyo}/mover`, { ...ca, body: { etapaId: otra.id } })).status, 200);
  assert.equal((await api('POST', `/clientes/${ajeno}/mover`, { ...ca, body: { etapaId: otra.id } })).status, 403);
  assert.equal((await api('POST', `/clientes/${ajeno}/renovaciones`, { ...ca, body: { programa: 'x', meses: 1, montoTotal: 1 } })).status, 403);
  assert.equal((await api('DELETE', `/clientes/${suyo}`, ca)).status, 403);
  assert.equal((await api('POST', '/cliente-etapas', { ...ca, body: { nombre: 'X' } })).status, 403);

  // Admin cambia la coach (solo a alguien con rol coach)
  assert.equal((await api('PATCH', `/clientes/${ajeno}`, { body: { coach_id: coachA.id } })).status, 200);
  assert.equal((await api('PATCH', `/clientes/${ajeno}`, { ...ca, body: { telefono: '999' } })).status, 200);
  assert.equal((await api('PATCH', `/clientes/${ajeno}`, { body: { meses: 500 } })).status, 400);
  assert.equal((await api('PATCH', `/clientes/${ajeno}`, { body: { vence: '2026-13-01' } })).status, 400);
  assert.equal((await api('PATCH', `/clientes/${ajeno}`, { body: { nombre: '' } })).status, 400);

  // Otros roles: 403
  const setter = await userSession({ nombre: 'Seti', email: 'seti@test.com', roles: ['setter'] });
  assert.equal((await api('GET', '/clientes', { cookie: setter.cookie })).status, 403);
  assert.equal((await api('GET', `/clientes/${suyo}`, { cookie: setter.cookie })).status, 403);
  assert.equal((await api('GET', '/clientes', { cookie: '' })).status, 401);

  // Admin borra el cliente (y sus pagos)
  assert.equal((await api('DELETE', `/clientes/${suyo}`)).status, 200);
  assert.equal((await api('GET', `/clientes/${suyo}`)).status, 404);
  assert.equal((await api('GET', '/clientes/no-uuid')).status, 404);
});
