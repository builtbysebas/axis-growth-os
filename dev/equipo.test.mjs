// Módulo Equipo: EOD, preguntas, revisión y metas contra un Postgres en memoria.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

let setter;
let closer;
let coach;
let setter2;

async function hoyStr() {
  const { query } = await import('../api/_lib/db.js');
  const [r] = await query("select (now() at time zone 'America/Lima')::date::text as d");
  return r.d;
}
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

test('preparar usuarios', async () => {
  await adminSession();
  setter = await userSession({ nombre: 'Nacho', email: 'nacho@test.com', roles: ['setter'] });
  setter2 = await userSession({ nombre: 'Edu', email: 'edu@test.com', roles: ['setter'] });
  closer = await userSession({ nombre: 'Ana', email: 'ana@test.com', roles: ['closer'] });
  coach = await userSession({ nombre: 'Fabi', email: 'fabi@test.com', roles: ['coach'] });
});

test('preguntas: admin crea, edita, desactiva y reordena; los demás no', async () => {
  let r = await api('GET', '/eod/preguntas');
  assert.equal(r.status, 200);
  assert.equal(r.json.preguntas.length, 4, 'las 4 preguntas iniciales del setter');
  assert.deepEqual(r.json.preguntas[0].roles, ['setter']);

  assert.equal((await api('GET', '/eod/preguntas', { cookie: setter.cookie })).status, 403);
  assert.equal((await api('POST', '/eod/preguntas', { cookie: setter.cookie, body: { texto: 'x', tipo: 'numero', roles: ['setter'] } })).status, 403);

  assert.equal((await api('POST', '/eod/preguntas', { body: { texto: '', tipo: 'numero', roles: ['setter'] } })).status, 400);
  assert.equal((await api('POST', '/eod/preguntas', { body: { texto: 'X', tipo: 'otro', roles: ['setter'] } })).status, 400);
  assert.equal((await api('POST', '/eod/preguntas', { body: { texto: 'X', tipo: 'numero', roles: ['admin'] } })).status, 400);

  r = await api('POST', '/eod/preguntas', { body: { texto: '¿Cómo te fue?', tipo: 'texto', roles: ['closer', 'coach', 'admin'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.pregunta.roles, ['closer', 'coach']);
  const comoId = r.json.pregunta.id;

  r = await api('POST', '/eod/preguntas', { body: { texto: '¿Hiciste reactivación?', tipo: 'sino', roles: ['setter'] } });
  const reactId = r.json.pregunta.id;
  r = await api('POST', '/eod/preguntas', { body: { texto: 'Vieja', tipo: 'numero', roles: ['setter'] } });
  const viejaId = r.json.pregunta.id;

  r = await api('PATCH', `/eod/preguntas/${viejaId}`, { body: { activa: false } });
  assert.equal(r.json.pregunta.activa, false);
  assert.equal((await api('PATCH', `/eod/preguntas/${viejaId}`, { body: { roles: [] } })).status, 400);
  assert.equal((await api('PATCH', `/eod/preguntas/${viejaId}`, { body: { tipo: 'raro' } })).status, 400);
  assert.equal((await api('PATCH', '/eod/preguntas/no-uuid', { body: { activa: true } })).status, 404);
  r = await api('PATCH', `/eod/preguntas/${comoId}`, { body: { texto: '  ¿Cómo te fue hoy?  ' } });
  assert.equal(r.json.pregunta.texto, '¿Cómo te fue hoy?');

  // Reordenar: tiene que incluir todas
  const all = (await api('GET', '/eod/preguntas')).json.preguntas.map((p) => p.id);
  assert.equal((await api('PUT', '/eod/preguntas/orden', { body: { ids: all.slice(1) } })).status, 400);
  assert.equal((await api('PUT', '/eod/preguntas/orden', { body: { ids: [...all.slice(1), all[1]] } })).status, 400);
  const nuevo = [...all].reverse();
  r = await api('PUT', '/eod/preguntas/orden', { body: { ids: nuevo } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.preguntas.map((p) => p.id), nuevo);
  await api('PUT', '/eod/preguntas/orden', { body: { ids: all } });
  assert.ok(reactId);
});

test('Mi EOD: cada rol ve solo sus preguntas activas', async () => {
  let r = await api('GET', '/eod/mio', { cookie: setter.cookie });
  assert.equal(r.status, 200);
  const textos = r.json.preguntas.map((p) => p.texto);
  assert.ok(textos.includes('Outbound'));
  assert.ok(textos.includes('¿Hiciste reactivación?'));
  assert.ok(!textos.includes('Vieja'), 'la desactivada no aparece');
  assert.ok(!textos.includes('¿Cómo te fue hoy?'), 'la del closer no aparece');
  assert.ok(r.json.resumen.setter, 'resumen del CRM para setter');
  assert.equal(r.json.resumen.closer, null);
  assert.equal(r.json.envio, null);

  r = await api('GET', '/eod/mio', { cookie: closer.cookie });
  assert.deepEqual(r.json.preguntas.map((p) => p.texto), ['¿Cómo te fue hoy?']);
  assert.ok(r.json.resumen.closer);
  assert.equal(r.json.resumen.setter, null);

  r = await api('GET', '/eod/mio', { cookie: coach.cookie });
  assert.deepEqual(r.json.preguntas.map((p) => p.texto), ['¿Cómo te fue hoy?']);

  // Sin sesión / fecha futura / fecha inválida
  assert.equal((await api('GET', '/eod/mio', { cookie: '' })).status, 401);
  const hoy = await hoyStr();
  assert.equal((await api('GET', `/eod/mio?fecha=${addDays(hoy, 2)}`, { cookie: setter.cookie })).status, 400);
  assert.equal((await api('GET', '/eod/mio?fecha=ayer', { cookie: setter.cookie })).status, 400);
});

test('Mi EOD: upsert, validaciones e historial', async () => {
  const hoy = await hoyStr();
  const ayer = addDays(hoy, -1);
  const pre = (await api('GET', '/eod/mio', { cookie: setter.cookie })).json.preguntas;
  const id = (t) => pre.find((p) => p.texto === t).id;

  // vacío → 400
  assert.equal((await api('PUT', '/eod/mio', { cookie: setter.cookie, body: { fecha: hoy, respuestas: {} } })).status, 400);
  // negativo / no número / sí-no inválido → 400
  assert.equal((await api('PUT', '/eod/mio', { cookie: setter.cookie, body: { fecha: hoy, respuestas: { [id('Outbound')]: -3 } } })).status, 400);
  assert.equal((await api('PUT', '/eod/mio', { cookie: setter.cookie, body: { fecha: hoy, respuestas: { [id('Outbound')]: 'muchos' } } })).status, 400);
  assert.equal((await api('PUT', '/eod/mio', { cookie: setter.cookie, body: { fecha: hoy, respuestas: { [id('¿Hiciste reactivación?')]: 'quizás' } } })).status, 400);
  // futura → 400
  assert.equal((await api('PUT', '/eod/mio', { cookie: setter.cookie, body: { fecha: addDays(hoy, 3), respuestas: { [id('Outbound')]: 1 } } })).status, 400);

  let r = await api('PUT', '/eod/mio', {
    cookie: setter.cookie,
    body: {
      fecha: ayer,
      respuestas: { [id('Outbound')]: 50, [id('Respuestas a Outbound')]: '10', [id('Inbound')]: 5, [id('¿Hiciste reactivación?')]: true, 'no-existe': 9 },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.respuestas[id('Respuestas a Outbound')], 10);
  assert.equal(r.json.respuestas['no-existe'], undefined, 'ignora preguntas que no le tocan');
  const creado = r.json.envio.creado;

  // segundo envío del mismo día = misma fila (upsert), quita lo vaciado
  r = await api('PUT', '/eod/mio', {
    cookie: setter.cookie,
    body: { fecha: ayer, respuestas: { [id('Outbound')]: 60, [id('Respuestas a Outbound')]: 12, [id('Inbound')]: '' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.envio.creado, creado);
  assert.equal(r.json.respuestas[id('Outbound')], 60);
  assert.equal(r.json.respuestas[id('Inbound')], undefined);
  assert.equal(r.json.historial.length, 1);
  assert.equal(r.json.historial[0].fecha, ayer);

  const { query } = await import('../api/_lib/db.js');
  const [{ n }] = await query('select count(*)::int as n from ml_eod_envios where user_id = $1', [setter.id]);
  assert.equal(n, 1);

  r = await api('GET', `/eod/mio?fecha=${ayer}`, { cookie: setter.cookie });
  assert.equal(r.json.respuestas[id('Outbound')], 60);
  assert.ok(r.json.envio.actualizado);
  r = await api('GET', '/eod/mio/historial', { cookie: setter.cookie });
  assert.equal(r.json.historial.length, 1);

  // Otro setter y la closer
  await api('PUT', '/eod/mio', { cookie: setter2.cookie, body: { fecha: hoy, respuestas: { [id('Outbound')]: 20, [id('Respuestas a Outbound')]: 4 } } });
  const closerPre = (await api('GET', '/eod/mio', { cookie: closer.cookie })).json.preguntas;
  r = await api('PUT', '/eod/mio', { cookie: closer.cookie, body: { fecha: hoy, respuestas: { [closerPre[0].id]: 'Bien, 2 ventas' } } });
  assert.equal(r.status, 200);
  // la closer no puede responder preguntas del setter
  r = await api('PUT', '/eod/mio', { cookie: closer.cookie, body: { fecha: hoy, respuestas: { [id('Outbound')]: 99 } } });
  assert.equal(r.status, 400);
});

test('revisión del equipo: sumas del EOD + métricas del CRM, filtro y permisos', async () => {
  const hoy = await hoyStr();
  const from = addDays(hoy, -7);
  assert.equal((await api('GET', `/eod/revision?from=${from}&to=${hoy}`, { cookie: setter.cookie })).status, 403);
  assert.equal((await api('GET', '/eod/revision')).status, 400);

  // Una agenda calificada del setter hoy, para el % conversación → agenda calificada
  await api('POST', '/ventas', { body: { nombre: 'Lead A', setter_id: setter.id, closer_id: closer.id } });

  let r = await api('GET', `/eod/revision?from=${from}&to=${hoy}`);
  assert.equal(r.status, 200);
  const nacho = r.json.setters.find((s) => s.user.id === setter.id);
  assert.equal(nacho.eod.outbound, 60);
  assert.equal(nacho.eod.respuestasOutbound, 12);
  assert.equal(nacho.eod.inbound, null);
  assert.equal(nacho.eod.pctRespuestaOutbound, 20);
  assert.equal(nacho.eod.nuevasConversaciones, 12);
  assert.equal(nacho.metrics.calificadas, 1);
  assert.ok(Math.abs(nacho.eod.pctConvCalificada - (1 / 12) * 100) < 1e-9);
  assert.equal(nacho.eod.enviados, 1);
  const edu = r.json.setters.find((s) => s.user.id === setter2.id);
  assert.equal(edu.eod.outbound, 20);
  assert.equal(r.json.closers.length, 1);
  assert.equal(r.json.closers[0].enviados, 1);
  assert.equal(r.json.envios.length, 3);
  assert.ok(r.json.usuarios.some((u) => u.id === coach.id));

  r = await api('GET', `/eod/revision?from=${from}&to=${hoy}&userId=${setter2.id}`);
  assert.equal(r.json.envios.length, 1);
  assert.equal(r.json.envios[0].user_id, setter2.id);
  assert.equal(r.json.setters.length, 2, 'la tabla sigue mostrando a todos');
  assert.equal((await api('GET', `/eod/revision?from=${from}&to=${hoy}&userId=x`)).status, 400);

  // Renombrar «Outbound» → deja de reconocerse (como en la versión completa)
  const pre = (await api('GET', '/eod/preguntas')).json.preguntas;
  const outId = pre.find((p) => p.texto === 'Outbound').id;
  await api('PATCH', `/eod/preguntas/${outId}`, { body: { texto: 'Mensajes en frío' } });
  r = await api('GET', `/eod/revision?from=${from}&to=${hoy}`);
  assert.equal(r.json.setters.find((s) => s.user.id === setter.id).eod.outbound, null);
  assert.equal(r.json.setters.find((s) => s.user.id === setter.id).eod.porPregunta[outId], 60, 'la suma por pregunta sigue');
  // y con otra forma de escribir (mayúsculas, tildes, guión) se vuelve a reconocer
  await api('PATCH', `/eod/preguntas/${outId}`, { body: { texto: '  OUTBOUND ' } });
  r = await api('GET', `/eod/revision?from=${from}&to=${hoy}`);
  assert.equal(r.json.setters.find((s) => s.user.id === setter.id).eod.outbound, 60);
});

test('metas: admin edita y ve a todo el equipo; setter/closer solo las suyas', async () => {
  const hoy = await hoyStr();
  // Semana del lunes; el servidor normaliza cualquier día de la semana
  let r = await api('GET', `/metas?periodo=semana&inicio=${hoy}`);
  assert.equal(r.status, 200);
  const lunes = r.json.inicio;
  assert.equal(new Date(`${lunes}T12:00:00Z`).getUTCDay(), 1);
  assert.equal(r.json.fin, addDays(lunes, 6));
  assert.equal(r.json.puedeEditar, true);
  assert.equal(r.json.filas.filter((f) => f.rol === 'setter').length, 2);
  assert.equal(r.json.filas.filter((f) => f.rol === 'closer').length, 1);

  // Validaciones
  const put = (body, cookie) => api('PUT', '/metas', { body, cookie });
  assert.equal((await put({ userId: setter.id, metrica: 'setter_cash', periodo: 'semana', inicio: hoy, valor: 1000 }, setter.cookie)).status, 403);
  assert.equal((await put({ userId: setter.id, metrica: 'inventada', periodo: 'semana', inicio: hoy, valor: 1 })).status, 400);
  assert.equal((await put({ userId: setter.id, metrica: 'closer_shows', periodo: 'semana', inicio: hoy, valor: 1 })).status, 400, 'rol equivocado');
  assert.equal((await put({ userId: setter.id, metrica: 'setter_cash', periodo: 'año', inicio: hoy, valor: 1 })).status, 400);
  assert.equal((await put({ userId: setter.id, metrica: 'setter_cash', periodo: 'semana', inicio: hoy, valor: -5 })).status, 400);
  assert.equal((await put({ userId: 'x', metrica: 'setter_cash', periodo: 'semana', inicio: hoy, valor: 5 })).status, 400);

  // Upsert (dos veces = una fila) con cualquier día de la semana
  r = await put({ userId: setter.id, metrica: 'setter_outbound', periodo: 'semana', inicio: hoy, valor: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.json.meta.inicio, lunes);
  await put({ userId: setter.id, metrica: 'setter_outbound', periodo: 'semana', inicio: addDays(lunes, 3), valor: 120 });
  await put({ userId: setter.id, metrica: 'setter_calificadas', periodo: 'semana', inicio: lunes, valor: 4 });
  await put({ userId: closer.id, metrica: 'closer_shows', periodo: 'semana', inicio: lunes, valor: 10 });
  const { query } = await import('../api/_lib/db.js');
  const [{ n }] = await query("select count(*)::int as n from ml_metas where user_id = $1 and metrica = 'setter_outbound'", [setter.id]);
  assert.equal(n, 1);

  // Progreso en vivo
  r = await api('GET', `/metas?periodo=semana&inicio=${lunes}`);
  const fila = r.json.filas.find((f) => f.user.id === setter.id && f.rol === 'setter');
  const out = fila.metricas.find((m) => m.metrica === 'setter_outbound');
  assert.equal(out.meta, 120);
  // El EOD de «ayer» (60) cuenta solo si ayer cae en esta semana
  const ayer = addDays(hoy, -1);
  const esperado = ayer >= lunes ? 60 : 0;
  assert.equal(out.actual, esperado);
  assert.equal(out.pct, (esperado / 120) * 100);
  const cal = fila.metricas.find((m) => m.metrica === 'setter_calificadas');
  assert.equal(cal.actual, 1);
  assert.equal(cal.pct, 25);
  assert.equal(fila.metricas.find((m) => m.metrica === 'setter_cash').meta, null);

  // Setter: solo sus metas
  r = await api('GET', `/metas?periodo=semana&inicio=${lunes}`, { cookie: setter.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.puedeEditar, false);
  assert.deepEqual([...new Set(r.json.filas.map((f) => f.user.id))], [setter.id]);
  r = await api('GET', `/metas?periodo=semana&inicio=${lunes}`, { cookie: setter2.cookie });
  assert.deepEqual([...new Set(r.json.filas.map((f) => f.user.id))], [setter2.id]);
  assert.ok(r.json.filas[0].metricas.every((m) => m.meta === null), 'no ve la meta de otro');
  // Closer: solo la suya; coach: sin acceso
  r = await api('GET', `/metas?periodo=semana&inicio=${lunes}`, { cookie: closer.cookie });
  assert.deepEqual(r.json.filas.map((f) => `${f.user.id}:${f.rol}`), [`${closer.id}:closer`]);
  assert.equal(r.json.filas[0].metricas.find((m) => m.metrica === 'closer_shows').meta, 10);
  assert.equal((await api('GET', '/metas', { cookie: coach.cookie })).status, 403);

  // Vacío borra la meta
  r = await put({ userId: setter.id, metrica: 'setter_outbound', periodo: 'semana', inicio: lunes, valor: '' });
  assert.equal(r.json.meta, null);
  r = await api('GET', `/metas?periodo=semana&inicio=${lunes}`);
  assert.equal(r.json.filas.find((f) => f.user.id === setter.id).metricas.find((m) => m.metrica === 'setter_outbound').meta, null);

  // Mes: se normaliza al día 1
  r = await put({ userId: closer.id, metrica: 'closer_cash', periodo: 'mes', inicio: hoy, valor: 5000 });
  assert.equal(r.json.meta.inicio, `${hoy.slice(0, 7)}-01`);
  r = await api('GET', `/metas?periodo=mes&inicio=${hoy}`);
  assert.equal(r.json.inicio, `${hoy.slice(0, 7)}-01`);
  assert.equal(r.json.filas.find((f) => f.rol === 'closer').metricas.find((m) => m.metrica === 'closer_cash').meta, 5000);
});

test('una persona setter+closer tiene metas separadas por rol', async () => {
  const both = await userSession({ nombre: 'Doble', email: 'doble@test.com', roles: ['setter', 'closer'] });
  const hoy = await hoyStr();
  await api('PUT', '/metas', { body: { userId: both.id, metrica: 'setter_ventas', periodo: 'mes', inicio: hoy, valor: 3 } });
  await api('PUT', '/metas', { body: { userId: both.id, metrica: 'closer_ventas', periodo: 'mes', inicio: hoy, valor: 8 } });
  const r = await api('GET', `/metas?periodo=mes&inicio=${hoy}`, { cookie: both.cookie });
  assert.equal(r.json.filas.length, 2);
  assert.equal(r.json.filas.find((f) => f.rol === 'setter').metricas.find((m) => m.metrica === 'setter_ventas').meta, 3);
  assert.equal(r.json.filas.find((f) => f.rol === 'closer').metricas.find((m) => m.metrica === 'closer_ventas').meta, 8);
});
