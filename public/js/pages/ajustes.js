// Pantalla «Ajustes» (/ajustes, admin): datos del negocio (nombre, zona horaria,
// meta de cash), cómo conectar ManyChat, cómo recibir agendas automáticamente
// (Calendly, Zapier, n8n o un formulario propio) y los últimos avisos recibidos.
// Usa las rutas de core: GET/PATCH /ajustes, GET /settings, GET /events.
import { get, patch } from '../core/api.js';
import { esc, fmtDateTime, on } from '../core/dom.js';
import { dxHeader, loading, toast } from '../core/ui.js';

const ZONAS = [
  ['America/Lima', 'Perú'],
  ['America/Bogota', 'Colombia'],
  ['America/Guayaquil', 'Ecuador'],
  ['America/Mexico_City', 'México (centro)'],
  ['America/Cancun', 'México (Cancún)'],
  ['America/Tijuana', 'México (Tijuana)'],
  ['America/Guatemala', 'Guatemala'],
  ['America/El_Salvador', 'El Salvador'],
  ['America/Tegucigalpa', 'Honduras'],
  ['America/Managua', 'Nicaragua'],
  ['America/Costa_Rica', 'Costa Rica'],
  ['America/Panama', 'Panamá'],
  ['America/Havana', 'Cuba'],
  ['America/Santo_Domingo', 'República Dominicana'],
  ['America/Puerto_Rico', 'Puerto Rico'],
  ['America/Caracas', 'Venezuela'],
  ['America/La_Paz', 'Bolivia'],
  ['America/Asuncion', 'Paraguay'],
  ['America/Santiago', 'Chile'],
  ['America/Argentina/Buenos_Aires', 'Argentina'],
  ['America/Montevideo', 'Uruguay'],
  ['America/Sao_Paulo', 'Brasil (São Paulo)'],
  ['Europe/Madrid', 'España (península)'],
  ['Atlantic/Canary', 'España (Canarias)'],
  ['America/New_York', 'EE. UU. (Este, Miami, Nueva York)'],
  ['America/Chicago', 'EE. UU. (Centro, Texas)'],
  ['America/Denver', 'EE. UU. (Montaña)'],
  ['America/Phoenix', 'EE. UU. (Arizona)'],
  ['America/Los_Angeles', 'EE. UU. (Pacífico, Los Ángeles)'],
];

const EVENT_LABELS = {
  content_reply: 'Respondió a un contenido',
  call_proposed: 'Llamada propuesta',
  link_sent: 'Link de agenda enviado',
};

function offsetOf(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return (p.find((x) => x.type === 'timeZoneName')?.value || '').replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

async function copyText(text, what = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      ta.remove();
    }
  }
  toast(`${what} ✓`);
}

function copyRow(value, { secret = false, label = '', key }) {
  return `
    <div class="lite-copyrow eq-copyrow">
      <input class="lite-input" type="${secret ? 'password' : 'text'}" readonly value="${esc(value)}" aria-label="${esc(label)}" data-copysrc="${esc(key)}">
      ${secret ? `<button type="button" class="btn-secondary" data-reveal="${esc(key)}">Mostrar</button>` : ''}
      <button type="button" class="btn-secondary" data-copy="${esc(key)}">Copiar</button>
    </div>`;
}

function codeBlock(text, key) {
  return `<div class="eq-codewrap"><pre class="eq-code">${esc(text)}</pre><button type="button" class="btn-secondary btn-sm eq-code-copy" data-copy="${esc(key)}">Copiar</button></div>`;
}

const json = (o) => JSON.stringify(o, null, 2);

export async function render(root, ctx) {
  root.innerHTML = `
    <div class="crm-page dx-page eq-ajustes">
      ${dxHeader({ eyebrow: 'Equipo', title: 'Ajustes' })}
      <div data-content>${loading()}</div>
    </div>`;
  const content = root.querySelector('[data-content]');
  const copies = {}; // clave → texto a copiar

  let aj;
  let settings;
  let events;
  try {
    [aj, settings, events] = await Promise.all([get('/ajustes'), get('/settings'), get('/events')]);
  } catch (err) {
    content.innerHTML = `<div class="lite-empty">No se pudieron cargar los ajustes: ${esc(err.message)}</div>`;
    return;
  }

  const secret = settings.manychatSecret;
  const origin = (() => {
    try {
      return new URL(settings.manychatUrl).origin;
    } catch {
      return location.origin;
    }
  })();
  const agendaUrl = `${origin}/api/webhooks/agenda?k=${secret}`;
  copies.mcUrl = settings.manychatUrl;
  copies.mcSecret = secret;
  copies.mcHeader = `x-webhook-secret: ${secret}`;
  copies.agUrl = agendaUrl;

  const ejemplos = {
    exReply: {
      eventType: 'content_reply',
      contactId: '{{user_id}}',
      contentCode: 'P - INSULINA - 06/10/2026',
      leadName: '{{full_name}}',
      leadUsername: '{{ig_username}}',
    },
    exProposed: {
      eventType: 'call_proposed',
      contactId: '{{user_id}}',
      setterEmail: 'correo-del-setter@ejemplo.com',
      leadName: '{{full_name}}',
      leadUsername: '{{ig_username}}',
    },
    exLink: {
      eventType: 'link_sent',
      contactId: '{{user_id}}',
      setterEmail: 'correo-del-setter@ejemplo.com',
      leadName: '{{full_name}}',
      leadUsername: '{{ig_username}}',
    },
    exAgenda: {
      nombre: 'María Pérez',
      telefono: '+51 999 888 777',
      email: 'maria@ejemplo.com',
      instagram: 'mariaperez',
      contactId: '123456789',
      fechaLlamada: '2026-12-01T15:00:00-05:00',
      setterEmail: 'correo-del-setter@ejemplo.com',
      closerEmail: 'correo-de-la-closer@ejemplo.com',
      presupuesto: 'con',
      origen: 'formulario',
      ref: 'id-unico-de-esta-agenda',
    },
  };
  for (const [k, v] of Object.entries(ejemplos)) copies[k] = json(v);

  const zonaKnown = ZONAS.some(([z]) => z === aj.zona);
  const zonas = zonaKnown ? ZONAS : [[aj.zona, aj.zona], ...ZONAS];

  function eventsTable() {
    const list = (events?.events || []).slice(0, 25);
    if (!list.length) return '<div class="lite-empty">Todavía no llegó ningún aviso de ManyChat. Cuando configures la automatización, aparecen acá.</div>';
    return `
      <div class="lite-table-wrap">
        <table class="lite-table">
          <thead><tr><th>Cuándo</th><th>Qué pasó</th><th>Lead</th><th>Contenido</th><th>Setter</th></tr></thead>
          <tbody>${list
            .map((e) => {
              const lead = [e.nombre, e.usuario_ig ? `@${e.usuario_ig}` : ''].filter(Boolean).join(' · ') || e.contact_id || '—';
              const cont =
                e.tipo !== 'content_reply'
                  ? '<span class="eq-muted">—</span>'
                  : e.contenido_titulo
                    ? esc(e.contenido_titulo)
                    : `<span class="lite-pill amber" title="El código no coincide con ningún contenido">Sin match</span>${e.codigo ? ` <span class="eq-muted">${esc(e.codigo)}</span>` : ''}`;
              const setter = e.setter_nombre ? esc(e.setter_nombre) : e.setter_email ? `<span class="lite-pill amber" title="Ese correo no es de ningún usuario">${esc(e.setter_email)}</span>` : '<span class="eq-muted">—</span>';
              return `<tr>
                <td class="eq-nowrap">${esc(fmtDateTime(e.recibido))}</td>
                <td><span class="lite-pill ${e.tipo === 'content_reply' ? 'indigo' : e.tipo === 'call_proposed' ? 'orange' : 'green'}">${esc(EVENT_LABELS[e.tipo] || e.tipo)}</span></td>
                <td>${esc(lead)}</td>
                <td>${cont}</td>
                <td>${setter}</td>
              </tr>`;
            })
            .join('')}</tbody>
        </table>
      </div>`;
  }

  content.innerHTML = `
    <section class="lite-card eq-card">
      <h2 class="eq-card-title">Tu negocio</h2>
      <form class="lite-form" data-negocio novalidate>
        <div class="lite-grid2">
          <div class="crm-field">
            <label class="crm-field-label" for="eq-negocio">Nombre del negocio</label>
            <input id="eq-negocio" name="negocio" maxlength="80" value="${esc(aj.negocio)}">
          </div>
          <div class="crm-field">
            <label class="crm-field-label" for="eq-meta">Meta de cash del mes (USD)</label>
            <input id="eq-meta" name="metaCash" type="number" min="0" step="1" inputmode="numeric" value="${esc(String(aj.metaCash ?? ''))}">
          </div>
        </div>
        <div class="crm-field">
          <label class="crm-field-label" for="eq-zona">Zona horaria</label>
          <select id="eq-zona" name="zona">
            ${zonas.map(([z, l]) => `<option value="${esc(z)}" ${z === aj.zona ? 'selected' : ''}>${esc(l)} · ${esc(offsetOf(z))}</option>`).join('')}
          </select>
        </div>
        <p class="lite-hint">La zona horaria decide dónde empieza y termina cada día en los reportes (Dashboard, EOD, Metas). Usa la de donde está el negocio.</p>
        <div class="lite-error" data-error></div>
        <div class="lite-actions"><button type="submit" class="crm-create-btn">Guardar cambios</button></div>
      </form>
    </section>

    <section class="lite-card eq-card">
      <h2 class="eq-card-title">Conectar ManyChat</h2>
      <p class="eq-lead">Con esto, cada respuesta a un contenido, cada llamada propuesta y cada link enviado por un setter llega solo a ${esc(aj.negocio)}: así se cuentan las propuestas y links de cada setter y se sabe qué contenido trajo cada agenda.</p>
      <div class="crm-field">
        <span class="crm-field-label">Dirección (URL)</span>
        ${copyRow(copies.mcUrl, { label: 'Dirección de ManyChat', key: 'mcUrl' })}
      </div>
      <div class="crm-field">
        <span class="crm-field-label">Clave secreta</span>
        ${copyRow(secret, { secret: true, label: 'Clave secreta', key: 'mcSecret' })}
        <p class="lite-hint eq-hint-after">No la compartas: con ella cualquiera podría mandarte avisos falsos.</p>
      </div>

      <h3 class="eq-subtitle">Paso a paso en ManyChat</h3>
      <ol class="eq-steps">
        <li>Abre la automatización y, en el punto donde quieres avisar, agrega una acción <strong>«External Request»</strong> (Solicitud externa).</li>
        <li>Método: <strong>POST</strong>. En la dirección pega la <strong>URL</strong> de arriba.</li>
        <li>En <strong>Headers</strong> agrega uno con nombre <code>x-webhook-secret</code> y como valor la <strong>clave secreta</strong>.
          ${codeBlock(copies.mcHeader, 'mcHeader')}</li>
        <li>En <strong>Body</strong> elige <strong>JSON</strong> y pega el ejemplo que corresponda (abajo). Los campos entre <code>{{ }}</code> insértalos desde el menú de campos de ManyChat, no los escribas a mano.</li>
        <li>Toca <strong>«Test the request»</strong>: tiene que responder <code>"ok": true</code>. El aviso aparece en la tabla de abajo.</li>
      </ol>

      <h3 class="eq-subtitle">Qué manda cada aviso</h3>
      <ul class="eq-fields">
        <li><code>eventType</code>: <strong>content_reply</strong> cuando la persona responde a un contenido (post, historia o anuncio); <strong>call_proposed</strong> cuando el setter le propone la llamada; <strong>link_sent</strong> cuando le manda el link de la agenda.</li>
        <li><code>contactId</code>: el ID del contacto en ManyChat (<code>{{user_id}}</code>). Es lo que une el chat con su agenda en Ventas.</li>
        <li><code>contentCode</code>: el código del contenido (lo ves en cada contenido, ej. <code>P - INSULINA - 06/10/2026</code>). Solo en content_reply.</li>
        <li><code>setterEmail</code>: el correo con el que el setter entra acá. En call_proposed y link_sent.</li>
        <li><code>leadName</code> y <code>leadUsername</code>: nombre y usuario de Instagram de la persona (opcionales).</li>
      </ul>

      <div class="eq-examples">
        <div><span class="crm-field-label">Respondió a un contenido</span>${codeBlock(copies.exReply, 'exReply')}</div>
        <div><span class="crm-field-label">El setter propuso la llamada</span>${codeBlock(copies.exProposed, 'exProposed')}</div>
        <div><span class="crm-field-label">El setter mandó el link</span>${codeBlock(copies.exLink, 'exLink')}</div>
      </div>
      <p class="lite-hint eq-hint-after">Si el código del contenido no coincide con ninguno, el aviso se guarda igual («Sin match»): nunca se pierde un lead.</p>
    </section>

    <section class="lite-card eq-card">
      <h2 class="eq-card-title">Recibir agendas automáticamente</h2>
      <p class="eq-lead">Pega esta dirección en la herramienta donde la gente agenda y cada agenda nueva entra sola a <strong>Ventas</strong>, en la primera columna. Sirve para <strong>Calendly</strong>, <strong>Zapier</strong>, <strong>n8n</strong> o un formulario propio.</p>
      <div class="crm-field">
        <span class="crm-field-label">Dirección para agendas (ya incluye la clave)</span>
        ${copyRow(agendaUrl, { secret: true, label: 'Dirección para agendas', key: 'agUrl' })}
        <p class="lite-hint eq-hint-after">Esta dirección lleva tu clave adentro: trátala como una contraseña.</p>
      </div>
      <ul class="eq-fields">
        <li><strong>Calendly:</strong> crea un webhook para el evento <strong>«invitee.created»</strong> y pega esta dirección. Se toman solos el nombre, correo, teléfono e Instagram de las preguntas, la hora de la llamada, la closer (por el correo del organizador) y el Contact ID de ManyChat si viaja como <code>utm_content</code> en el link.</li>
        <li><strong>Zapier, n8n o tu formulario:</strong> que haga un <strong>POST</strong> a esta dirección con un JSON como el de abajo. Solo <code>nombre</code> es obligatorio. <code>fechaLlamada</code> va con fecha y hora; <code>presupuesto</code> es <code>"con"</code> o <code>"sin"</code>; <code>setterEmail</code> y <code>closerEmail</code> son los correos con los que entran acá.</li>
        <li><code>ref</code> es un identificador único de esa agenda: si la herramienta reintenta el envío, no se duplica.</li>
      </ul>
      ${codeBlock(copies.exAgenda, 'exAgenda')}
    </section>

    <section class="lite-card eq-card">
      <h2 class="eq-card-title">Últimos avisos recibidos de ManyChat</h2>
      ${eventsTable()}
    </section>`;

  const offs = [
    on(content, 'click', '[data-copy]', (e, el) => copyText(copies[el.dataset.copy] ?? '')),
    on(content, 'click', '[data-reveal]', (e, el) => {
      const input = content.querySelector(`[data-copysrc="${CSS.escape(el.dataset.reveal)}"]`);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.textContent = show ? 'Ocultar' : 'Mostrar';
    }),
    on(content, 'submit', '[data-negocio]', async (e, form) => {
      e.preventDefault();
      const err = form.querySelector('[data-error]');
      err.textContent = '';
      const negocio = form.negocio.value.trim();
      const metaRaw = form.metaCash.value.trim();
      const meta = metaRaw === '' ? 0 : Number(metaRaw);
      if (!negocio) return (err.textContent = 'Escribe el nombre del negocio.');
      if (!Number.isFinite(meta) || meta < 0) return (err.textContent = 'La meta tiene que ser un número de 0 en adelante.');
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await patch('/ajustes', { negocio, zona: form.zona.value, metaCash: meta });
        await ctx.reloadAjustes();
        toast('Ajustes guardados ✓ (el nombre del menú cambia al recargar la página)');
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        btn.disabled = false;
      }
    }),
  ];
  return () => offs.forEach((off) => off());
}
