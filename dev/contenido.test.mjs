// Contenido: código único, permisos, recursos/ángulos, ManyChat y atribución.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminSession, api, setup, teardown, userSession } from './harness.mjs';

before(setup);
after(teardown);

test('código para ManyChat: generado, único y se regenera', async () => {
  await adminSession();

  // Validaciones
  assert.equal((await api('POST', '/contenido', { body: { kind: 'otro', titulo: 'x', fecha: '2026-12-01' } })).status, 400);
  assert.equal((await api('POST', '/contenido', { body: { kind: 'post', titulo: '', fecha: '2026-12-01' } })).status, 400);
  assert.equal((await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Hola' } })).status, 400);
  assert.equal((await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Hola', fecha: '2026-12-01', estado: 'activo' } })).status, 400);
  assert.equal((await api('POST', '/contenido', { body: { kind: 'story', titulo: 'Hola', fecha: '2026-12-01', formato: 'Reel' } })).status, 400);
  assert.equal((await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Hola', fecha: '2026-12-01', link: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Hola', fecha: '2026-12-01', gasto: 10 } })).status, 400);

  // CTA con tildes → palabra en mayúsculas sin tildes
  let r = await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Calculadora de macros', cta: 'calculadóra', fecha: '2026-12-01' } });
  assert.equal(r.status, 200);
  const a = r.json.item;
  assert.equal(a.codigo, 'P - CALCULADORA - 01/12/2026');
  assert.equal(a.estado, 'idea');
  assert.equal(a.fecha, '2026-12-01');
  assert.equal(a.leads, 0);

  // Repetido → " 2", " 3"
  r = await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Otra', cta: 'Calculadora', fecha: '2026-12-01' } });
  assert.equal(r.json.item.codigo, 'P - CALCULADORA - 01/12/2026 2');
  const b = r.json.item;
  r = await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Otra más', cta: 'CALCULADORA', fecha: '2026-12-01' } });
  assert.equal(r.json.item.codigo, 'P - CALCULADORA - 01/12/2026 3');

  // Sin CTA → primeras palabras del título; historia S, ad A
  r = await api('POST', '/contenido', { body: { kind: 'story', titulo: 'Resistencia a la insulina hoy', fecha: '2026-12-02' } });
  assert.equal(r.json.item.codigo, 'S - RESISTENCIA A LA - 02/12/2026');
  r = await api('POST', '/contenido', { body: { kind: 'ad', titulo: 'Claudia', fecha: '2026-12-03', gasto: '12,50' } });
  assert.equal(r.json.item.codigo, 'A - CLAUDIA - 03/12/2026');
  assert.equal(r.json.item.estado, 'pausado');
  assert.equal(Number(r.json.item.gasto), 12.5);

  // Cambiar el título con CTA cargado no cambia el código
  r = await api('PATCH', `/contenido/${a.id}`, { body: { titulo: 'Calculadora nueva' } });
  assert.equal(r.json.item.codigo, 'P - CALCULADORA - 01/12/2026');
  assert.equal(r.json.aviso, undefined);
  // Cambiar la fecha sí
  r = await api('PATCH', `/contenido/${a.id}`, { body: { fecha: '2026-12-05' } });
  assert.equal(r.json.item.codigo, 'P - CALCULADORA - 05/12/2026');
  // El que era " 2" no cambia si se guarda igual
  r = await api('PATCH', `/contenido/${b.id}`, { body: { titulo: 'Otra (editada)' } });
  assert.equal(r.json.item.codigo, 'P - CALCULADORA - 01/12/2026 2');
  // Cambiar el CTA
  r = await api('PATCH', `/contenido/${a.id}`, { body: { cta: 'Macros' } });
  assert.equal(r.json.item.codigo, 'P - MACROS - 05/12/2026');

  // Carrusel: el tipo va al título, el código no cambia
  r = await api('PATCH', `/contenido/${a.id}`, { body: { formato: 'Carrusel animado' } });
  assert.equal(r.json.item.titulo, 'CARRUSEL ANIMADO: Calculadora nueva');
  assert.equal(r.json.item.codigo, 'P - MACROS - 05/12/2026');
  r = await api('PATCH', `/contenido/${a.id}`, { body: { formato: 'Reel' } });
  assert.equal(r.json.item.titulo, 'Calculadora nueva');
  assert.equal((await api('PATCH', `/contenido/${a.id}`, { body: { formato: 'Inventado' } })).status, 400);
  assert.equal((await api('PATCH', `/contenido/${a.id}`, { body: { fecha: 'mañana' } })).status, 400);
  assert.equal((await api('PATCH', `/contenido/${a.id}`, { body: { angulo_id: '00000000-0000-0000-0000-000000000000' } })).status, 400);

  // Guion y etiqueta
  r = await api('PATCH', `/contenido/${a.id}`, { body: { guion: 'Línea 1\nLínea 2', etiqueta: 'Anuncio' } });
  assert.equal(r.json.item.guion, 'Línea 1\nLínea 2');
  r = await api('GET', `/contenido/${a.id}`);
  assert.equal(r.json.item.guion, 'Línea 1\nLínea 2');
  assert.equal(r.json.item.etiqueta, 'Anuncio');

  // Buscador
  r = await api('GET', '/contenido/buscar?q=calcul');
  assert.ok(r.json.items.length >= 2);
  assert.deepEqual(Object.keys(r.json.items[0]).sort(), ['codigo', 'fecha', 'id', 'kind', 'titulo']);
  r = await api('GET', '/contenido/buscar?q=%25');
  assert.equal(r.json.items.length, 0, 'el % se busca literal');
  r = await api('GET', '/contenido/buscar?q=resistencía');
  assert.equal(r.json.items.length, 1, 'sin importar tildes');

  // Borrar
  assert.equal((await api('DELETE', `/contenido/${b.id}`)).status, 200);
  assert.equal((await api('DELETE', `/contenido/${b.id}`)).status, 404);
  assert.equal((await api('GET', `/contenido/no-es-uuid`)).status, 404);
});

test('permisos: todos ven posts e historias; solo admin edita y ve ads', async () => {
  await adminSession();
  const setter = await userSession({ nombre: 'Nacho', email: 'nacho@test.com', roles: ['setter'] });
  const coach = await userSession({ nombre: 'Fabi', email: 'fabi@test.com', roles: ['coach'] });

  let r = await api('GET', '/contenido?kind=post', { cookie: setter.cookie });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.items) && Array.isArray(r.json.angulos) && Array.isArray(r.json.recursos));
  assert.equal((await api('GET', '/contenido?kind=story', { cookie: coach.cookie })).status, 200);
  assert.equal((await api('GET', '/contenido?kind=ad', { cookie: setter.cookie })).status, 403);
  assert.equal((await api('GET', '/contenido?kind=xx')).status, 400);
  r = await api('GET', '/contenido', { cookie: setter.cookie });
  assert.ok(r.json.items.every((i) => i.kind !== 'ad'), 'sin kind: el setter no recibe ads');
  r = await api('GET', '/contenido/buscar?q=claudia', { cookie: setter.cookie });
  assert.equal(r.json.items.length, 0, 'el buscador no muestra ads a quien no es admin');
  r = await api('GET', '/contenido/buscar?q=claudia');
  assert.equal(r.json.items.length, 1);
  const ad = r.json.items[0];
  assert.equal((await api('GET', `/contenido/${ad.id}`, { cookie: setter.cookie })).status, 403);

  assert.equal((await api('POST', '/contenido', { cookie: setter.cookie, body: { kind: 'post', titulo: 'x', fecha: '2026-12-01' } })).status, 403);
  const post = (await api('GET', '/contenido?kind=post')).json.items[0];
  assert.equal((await api('PATCH', `/contenido/${post.id}`, { cookie: setter.cookie, body: { titulo: 'x' } })).status, 403);
  assert.equal((await api('DELETE', `/contenido/${post.id}`, { cookie: setter.cookie })).status, 403);
  assert.equal((await api('POST', `/contenido/${post.id}/notas`, { cookie: setter.cookie, body: { texto: 'x' } })).status, 403);
  assert.equal((await api('POST', '/angulos', { cookie: setter.cookie, body: { nombre: 'x' } })).status, 403);
  assert.equal((await api('POST', '/recursos', { cookie: setter.cookie, body: { nombre: 'x' } })).status, 403);
  assert.equal((await api('GET', '/angulos', { cookie: coach.cookie })).status, 200);
  assert.equal((await api('GET', '/recursos', { cookie: coach.cookie })).status, 200);
  assert.equal((await api('GET', '/contenido', { cookie: '' })).status, 401);

  // Comentarios (admin)
  assert.equal((await api('POST', `/contenido/${post.id}/notas`, { body: { texto: '  ' } })).status, 400);
  r = await api('POST', `/contenido/${post.id}/notas`, { body: { texto: 'Grabar con luz natural' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.nota.autor, 'Admin');
  r = await api('GET', `/contenido/${post.id}`, { cookie: setter.cookie });
  assert.equal(r.json.notas.length, 1);
});

test('ángulos y recursos: CRUD, orden, vínculos y usos', async () => {
  await adminSession();
  let r = await api('POST', '/angulos', { body: { nombre: '' } });
  assert.equal(r.status, 400);
  const a1 = (await api('POST', '/angulos', { body: { nombre: 'Hormonas', descripcion: 'Mujeres +35' } })).json.angulo;
  const a2 = (await api('POST', '/angulos', { body: { nombre: 'Insulina' } })).json.angulo;
  assert.ok(a1.orden < a2.orden);
  r = await api('POST', '/angulos/orden', { body: { ids: [a2.id, a1.id] } });
  assert.deepEqual(r.json.angulos.map((a) => a.id).slice(0, 2), [a2.id, a1.id]);
  r = await api('PATCH', `/angulos/${a1.id}`, { body: { nombre: 'Hormonas 2' } });
  assert.equal(r.json.angulo.nombre, 'Hormonas 2');

  assert.equal((await api('POST', '/recursos', { body: { nombre: 'Guía', link: 'ftp://x' } })).status, 400);
  const rec = (await api('POST', '/recursos', { body: { nombre: 'Guía PDF', link: 'https://drive.google.com/x', tipo: 'PDF' } })).json.recurso;
  const rec2 = (await api('POST', '/recursos', { body: { nombre: 'Checklist' } })).json.recurso;
  assert.equal(rec.usos, 0);

  const item = (await api('POST', '/contenido', { body: { kind: 'story', titulo: 'Guía gratis', fecha: '2026-12-10', angulo_id: a1.id, tipo_story: 'Recurso Gratis', recurso_ids: [rec.id] } })).json.item;
  assert.equal(item.angulo_nombre, 'Hormonas 2');
  assert.deepEqual(item.recurso_ids, [rec.id]);
  r = await api('POST', `/contenido/${item.id}/recursos`, { body: { recurso_id: rec2.id } });
  assert.equal(r.json.recursos.length, 2);
  r = await api('POST', `/contenido/${item.id}/recursos`, { body: { recurso_id: rec2.id } });
  assert.equal(r.json.recursos.length, 2, 'vincular dos veces no duplica');
  assert.equal((await api('POST', `/contenido/${item.id}/recursos`, { body: { recurso_id: 'x' } })).status, 404);
  r = await api('GET', `/contenido/${item.id}`);
  assert.deepEqual(r.json.recursos.map((x) => x.nombre), ['Checklist', 'Guía PDF']);
  assert.equal(r.json.recursos[1].link, 'https://drive.google.com/x');
  r = await api('GET', '/recursos');
  assert.equal(r.json.recursos.find((x) => x.id === rec.id).usos, 1);
  r = await api('DELETE', `/contenido/${item.id}/recursos/${rec2.id}`);
  assert.equal(r.json.recursos.length, 1);
  r = await api('PATCH', `/contenido/${item.id}`, { body: { recurso_ids: [] } });
  assert.deepEqual(r.json.item.recurso_ids, []);
  assert.equal((await api('PATCH', `/contenido/${item.id}`, { body: { recurso_ids: ['malo'] } })).status, 400);

  // Contrato de Resultados: completar huecos
  r = await api('PATCH', `/contenido/${item.id}`, { body: { angulo_id: a2.id, tipo_story: 'Poll' } });
  assert.equal(r.json.item.angulo_id, a2.id);
  assert.equal(r.json.item.tipo_story, 'Poll');

  // Borrar un ángulo deja el contenido sin ángulo
  assert.equal((await api('DELETE', `/angulos/${a2.id}`)).status, 200);
  r = await api('GET', `/contenido/${item.id}`);
  assert.equal(r.json.item.angulo_id, '');
  assert.equal((await api('DELETE', `/recursos/${rec.id}`)).status, 200);
  assert.equal((await api('DELETE', `/recursos/${rec.id}`)).status, 404);
});

test('ManyChat suma leads y la atribución cuenta agendas, ventas y cash', async () => {
  await adminSession();
  const secret = (await api('GET', '/settings')).json.manychatSecret;
  const hook = (b) => api('POST', '/webhooks/manychat', { headers: { 'x-webhook-secret': secret }, body: b });

  const item = (await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Macros', cta: 'Macros', fecha: '2026-11-01' } })).json.item;
  const otro = (await api('POST', '/contenido', { body: { kind: 'post', titulo: 'Otro', cta: 'Otro', fecha: '2026-11-02' } })).json.item;

  // Dos respuestas del mismo contacto cuentan un lead; otro contacto suma otro.
  let r = await hook({ eventType: 'content_reply', contactId: '111', contentCode: item.codigo });
  assert.equal(r.json.matched, true);
  await hook({ eventType: 'content_reply', contactId: '111', contentCode: ` ${item.codigo.toLowerCase()} ` });
  await hook({ eventType: 'content_reply', contactId: '222', contentCode: item.codigo });
  await hook({ eventType: 'call_proposed', contactId: '333', contentCode: item.codigo });

  r = await api('GET', '/contenido?kind=post');
  let it = r.json.items.find((i) => i.id === item.id);
  assert.equal(it.leads, 2);
  assert.equal(it.agendas, 0);

  // Agenda del contacto 111 → atribuida a este contenido; venta con pago inicial y cuota.
  const v = (await api('POST', '/ventas', { body: { nombre: 'Lead', contact_id: '111' } })).json.venta;
  // Agenda con atribución manual a «otro»
  const v2 = (await api('POST', '/ventas', { body: { nombre: 'Lead 2', contact_id: '222' } })).json.venta;
  await api('PATCH', `/ventas/${v2.id}/atribucion`, { body: { contenidoId: otro.id } });
  // Agenda de alguien que respondió DESPUÉS de agendar: no cuenta
  const v3 = (await api('POST', '/ventas', { body: { nombre: 'Lead 3', contact_id: '444' } })).json.venta;
  await api('PATCH', `/ventas/${v3.id}`, { body: { agendada: '2026-01-01T00:00:00Z' } });
  await hook({ eventType: 'content_reply', contactId: '444', contentCode: item.codigo });

  r = await api('PUT', `/ventas/${v.id}/resultado`, { body: { resultado: 'venta', programa: '3 meses', meses: 3, montoTotal: 900, pagoInicial: 300 } });
  assert.equal(r.status, 200);

  r = await api('GET', '/contenido?kind=post');
  it = r.json.items.find((i) => i.id === item.id);
  assert.equal(it.leads, 3);
  assert.equal(it.agendas, 1);
  assert.equal(it.ventas, 1);
  assert.equal(it.cash, 300);
  const ot = r.json.items.find((i) => i.id === otro.id);
  assert.equal(ot.agendas, 1);
  assert.equal(ot.ventas, 0);

  // Con avisos de ManyChat el código ya no cambia, y se avisa.
  r = await api('PATCH', `/contenido/${item.id}`, { body: { cta: 'Calculadora' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.item.codigo, item.codigo);
  assert.equal(r.json.item.cta, 'Calculadora');
  assert.match(r.json.aviso, /ManyChat/);
  // Sin avisos sí cambia
  r = await api('PATCH', `/contenido/${otro.id}`, { body: { cta: 'Nuevo' } });
  assert.equal(r.json.item.codigo, 'P - NUEVO - 02/11/2026');
  assert.equal(r.json.aviso, undefined);

  // Borrar el contenido deja los avisos en «Sin match» y la agenda manual sin contenido
  assert.equal((await api('DELETE', `/contenido/${otro.id}`)).status, 200);
  r = await api('GET', `/ventas/${v2.id}`);
  assert.equal(r.json.venta.atrib_contenido_id, '');
  assert.equal((await api('DELETE', `/contenido/${item.id}`)).status, 200);
  r = await api('GET', '/events?sinMatch=1');
  assert.ok(r.json.events.length >= 3);
});
