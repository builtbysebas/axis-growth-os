// Pantalla «Ajustes» (/ajustes, admin): datos del negocio (nombre, zona horaria,
// meta de cash), cómo conectar ManyChat, cómo recibir agendas automáticamente
// (Calendly, Zapier, n8n o un formulario propio) y los últimos avisos recibidos.
// Usa las rutas de core: GET/PATCH /ajustes, GET /settings, GET /events.
import { get, patch, post } from '../core/api.js';
import { esc, fmtDateTime, on } from '../core/dom.js';
import { dxHeader, loading, toast } from '../core/ui.js';
import { applyTheme, normalizeColor, THEMES, DEFAULT_COLOR } from '../core/theme.js';

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
  let calendly;
  let usuarios = [];
  try {
    [aj, settings, events, calendly, usuarios] = await Promise.all([
      get('/ajustes'),
      get('/settings'),
      get('/events'),
      get('/calendly').then((r) => r.calendly),
      get('/usuarios').then((r) => r.usuarios || []).catch(() => []),
    ]);
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

  function calendlyCard() {
    if (calendly?.conectado) {
      return `
        <h2 class="eq-card-title">Calendly <span class="lite-pill green">Conectado</span></h2>
        <p class="eq-lead">Cada agenda de Calendly entra sola a <strong>Ventas</strong>, sin Zapier ni n8n. Cuenta: <strong>${esc(calendly.cuenta || calendly.nombre || '—')}</strong>${calendly.alcance === 'user' ? ' (solo las agendas de esta persona)' : ' (todas las personas de la cuenta)'} · desde ${esc(fmtDateTime(calendly.desde))}.</p>
        ${calendlyHelp()}
        <details class="eq-details">
          <summary>Desconectar o volver a conectar</summary>
          <p class="lite-hint">Pega de nuevo un token de Calendly (el mismo u otro) para confirmar.</p>
          ${tokenForm('Volver a conectar', true)}
        </details>`;
    }
    return `
      <h2 class="eq-card-title">Conectar Calendly</h2>
      <p class="eq-lead">Cada vez que alguien agende, cancele o se reagende en Calendly, se refleja solo en <strong>Ventas</strong>. Sin Zapier, sin n8n y sin pagar nada extra.</p>
      <ol class="eq-steps">
        <li>Entra a Calendly → <strong>Integraciones y apps</strong> → <strong>API y webhooks</strong> (<a href="https://calendly.com/integrations/api_webhooks" target="_blank" rel="noopener">abrir</a>).</li>
        <li>Toca <strong>«Obtener un token nuevo»</strong>, ponle de nombre <em>${esc(aj.negocio || 'Mi OS')}</em> y copia el token.</li>
        <li>Pégalo acá abajo y toca <strong>Conectar</strong>. El token no se guarda: solo se usa para crear la conexión.</li>
      </ol>
      ${tokenForm('Conectar', false)}
      ${calendlyHelp()}`;
  }

  function tokenForm(label, connected) {
    return `
      <form class="lite-form eq-token-form" data-calendly-form novalidate>
        <div class="crm-field">
          <label class="crm-field-label" for="eq-cal-token">Token de Calendly</label>
          <input id="eq-cal-token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="eyJraWQiOi…">
        </div>
        <div class="lite-error" data-error></div>
        <div class="lite-actions">
          <button type="submit" class="crm-create-btn">${esc(label)}</button>
          ${connected ? '<button type="button" class="btn-secondary" data-calendly-off>Desconectar</button>' : ''}
        </div>
      </form>`;
  }

  // ---- links por setter (solo se arman acá; nada se guarda en el servidor) ----
  const CAL_LINK_KEY = 'ago-cal-link';
  let calLink = '';
  try {
    calLink = localStorage.getItem(CAL_LINK_KEY) || '';
  } catch {
    /* sin almacenamiento */
  }
  const firstWord = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .split(/\s+/)[0]
      .replace(/[^a-z0-9._-]/g, '');
  const setters = usuarios.filter((u) => u.activo && (u.roles || []).includes('setter'));
  const closers = usuarios.filter((u) => u.activo && (u.roles || []).includes('closer'));

  /** Valor de utm_source que el OS reconoce: el primer nombre, o el correo si dos setters comparten nombre. */
  function setterTag(u) {
    const first = firstWord(u.nombre);
    const repeated = setters.filter((o) => firstWord(o.nombre) === first).length > 1;
    return !first || first.length < 2 || repeated ? u.email : first;
  }

  function buildLink(base, tag) {
    let raw = String(base || '').trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_content');
    url.searchParams.set('utm_source', tag);
    const direct = url.toString();
    return { direct, manychat: `${direct}&utm_content=` };
  }

  function setterLinks() {
    if (!setters.length) {
      return '<div class="lite-empty">Todavía no tienes setters activos. Créalos en <strong>Usuarios</strong> con el rol setter y vuelve acá.</div>';
    }
    if (!calLink.trim()) {
      return '<p class="lite-hint">Pega arriba tu link de Calendly y aparecen los links de cada setter listos para copiar.</p>';
    }
    const rows = setters.map((u) => {
      const l = buildLink(calLink, setterTag(u));
      if (!l) return '';
      copies[`sl_d_${u.id}`] = l.direct;
      copies[`sl_m_${u.id}`] = l.manychat;
      return `
        <div class="eq-setter-link">
          <div class="eq-setter-name">${esc(u.nombre)}</div>
          <span class="crm-field-label">Link directo (WhatsApp, bio, mensaje a mano)</span>
          ${copyRow(l.direct, { label: `Link de ${u.nombre}`, key: `sl_d_${u.id}` })}
          <span class="crm-field-label">Link para el botón de ManyChat</span>
          ${copyRow(l.manychat, { label: `Link de ManyChat de ${u.nombre}`, key: `sl_m_${u.id}` })}
        </div>`;
    });
    if (rows.every((r) => !r)) return '<p class="lite-error">Ese link no se entiende. Copia el link completo de tu evento en Calendly (ej. <code>calendly.com/tu-negocio/llamada</code>).</p>';
    return rows.join('');
  }

  function calendlyHelp() {
    const sinCorreo = closers.length
      ? `<p class="lite-hint">Tus closers acá: ${closers.map((c) => `<strong>${esc(c.nombre)}</strong> (${esc(c.email)})`).join(', ')}. Ese correo tiene que ser el mismo con el que cada una entra a Calendly.</p>`
      : '<p class="lite-hint">Todavía no tienes closers activas. Créalas en <strong>Usuarios</strong> con el rol closer.</p>';
    return `
      <h3 class="eq-subtitle">Qué entra solo</h3>
      <ul class="eq-fields">
        <li>Nombre, correo y la hora de la llamada.</li>
        <li>Teléfono e Instagram, si tu formulario de Calendly tiene esas preguntas (que digan «teléfono», «celular», «WhatsApp» o «Instagram»).</li>
        <li><strong>Todas las respuestas del formulario</strong>, pregunta por pregunta, como primera nota de la agenda.</li>
        <li>Si la lead <strong>se reagenda</strong>, se mueve la misma agenda (no se duplica). Si <strong>cancela</strong>, queda anotado y vuelve a «para hoy» para que alguien la contacte.</li>
        <li>Lo único que se marca a mano es el <strong>presupuesto</strong> (con o sin), en la agenda.</li>
      </ul>

      <h3 class="eq-subtitle">1. Un link por setter (para saber de quién es cada agenda)</h3>
      <p class="eq-lead">No hace falta un evento distinto por setter: todos usan el <strong>mismo link</strong> de Calendly con una etiqueta al final (<code>?utm_source=nombre</code>). Cuando alguien agenda por ese link, la agenda queda asignada a ese setter.</p>
      <div class="crm-field">
        <label class="crm-field-label" for="eq-cal-link">Tu link de Calendly</label>
        <input id="eq-cal-link" class="lite-input" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://calendly.com/tu-negocio/llamada" value="${esc(calLink)}" data-cal-link>
        <p class="lite-hint eq-hint-after">Es el link del evento que comparten con las leads. Se recuerda solo en este navegador.</p>
      </div>
      <div class="eq-setter-links" data-setter-links>${setterLinks()}</div>
      <p class="lite-hint eq-hint-after">Si cambias el nombre de un setter o entra uno nuevo, vuelve acá a copiar su link. Si dos setters tienen el mismo primer nombre, su link lleva el correo en vez del nombre.</p>

      <h3 class="eq-subtitle">2. ManyChat: unir la agenda con el chat (Contact ID)</h3>
      <ol class="eq-steps">
        <li>En la automatización de ManyChat donde el setter manda el link, en el botón pega el <strong>Link para el botón de ManyChat</strong> de ese setter. Termina en <code>utm_content=</code>.</li>
        <li>Con el cursor justo después del <code>=</code>, toca el botón de campos <strong>{ }</strong> y elige <strong>Contact Id</strong> (en algunas cuentas sale como <em>User Id</em>). No lo escribas a mano: tiene que ser el campo.</li>
        <li>Queda así: <code>…?utm_source=rocio&amp;utm_content=</code><strong>Contact Id</strong>. Cada lead recibe su propio número.</li>
      </ol>
      <p class="lite-hint">Con eso la agenda guarda el Contact ID y en <strong>Resultados</strong> se ve qué contenido trajo a esa persona (el último que respondió antes de agendar). Para que funcione, ManyChat también tiene que avisar cuando responden a tus contenidos (tarjeta «Conectar ManyChat», más arriba).</p>

      <h3 class="eq-subtitle">3. Varias closers (round robin)</h3>
      <ul class="eq-fields">
        <li>En Calendly crea un evento de equipo tipo <strong>Round Robin</strong> con tus closers: Calendly decide a quién le toca cada llamada (esta función es de los planes pagos de Calendly).</li>
        <li>El OS asigna la agenda a la closer por su <strong>correo</strong>: el de Calendly tiene que ser el mismo con el que entra acá. Si no coinciden, la agenda entra sin closer y se asigna a mano.</li>
        <li>Los links de setter de arriba funcionan igual con un evento Round Robin: usa el link del evento de equipo.</li>
      </ul>
      ${sinCorreo}`;
  }

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
      <h2 class="eq-card-title">Color del sistema</h2>
      <p class="eq-lead">El color de tu marca en botones, menú, gráficos y en la pantalla de inicio de sesión. Lo ve todo tu equipo.</p>
      <div class="eq-themes" role="radiogroup" aria-label="Color del sistema" data-themes>
        ${THEMES.map(
          (th) => `<button type="button" class="eq-theme" role="radio" data-color="${th.color}" aria-label="${esc(th.label)}" title="${esc(th.label)}">
            <span class="eq-theme-dot" style="background:linear-gradient(135deg, ${th.color}, ${th.color2})"></span>
            <span class="eq-theme-name">${esc(th.label)}</span>
          </button>`,
        ).join('')}
        <label class="eq-theme eq-theme-custom" title="Elegir otro color">
          <span class="eq-theme-dot eq-theme-dot-custom"><input type="color" data-custom aria-label="Otro color"></span>
          <span class="eq-theme-name">Otro</span>
        </label>
      </div>
      <p class="lite-hint eq-hint-after">Si eliges un color muy claro, se oscurece un poco solo para que el texto blanco de los botones se lea.</p>
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

    <section class="lite-card eq-card" data-calendly-card>
      ${calendlyCard()}
    </section>

    <section class="lite-card eq-card">
      <h2 class="eq-card-title">Recibir agendas desde otra herramienta</h2>
      <p class="eq-lead">Si no usas Calendly (o prefieres otra vía), pega esta dirección en la herramienta donde la gente agenda y cada agenda nueva entra sola a <strong>Ventas</strong>, en la primera columna. Sirve para <strong>Zapier</strong>, <strong>n8n</strong>, <strong>Make</strong> o un formulario propio.</p>
      <div class="crm-field">
        <span class="crm-field-label">Dirección para agendas (ya incluye la clave)</span>
        ${copyRow(agendaUrl, { secret: true, label: 'Dirección para agendas', key: 'agUrl' })}
        <p class="lite-hint eq-hint-after">Esta dirección lleva tu clave adentro: trátala como una contraseña.</p>
      </div>
      <ul class="eq-fields">
        <li><strong>Zapier, n8n o tu formulario:</strong> que haga un <strong>POST</strong> a esta dirección con un JSON como el de abajo. Solo <code>nombre</code> es obligatorio. <code>fechaLlamada</code> va con fecha y hora; <code>presupuesto</code> es <code>"con"</code> o <code>"sin"</code>; <code>setterEmail</code> y <code>closerEmail</code> son los correos con los que entran acá.</li>
        <li><code>ref</code> es un identificador único de esa agenda: si la herramienta reintenta el envío, no se duplica.</li>
      </ul>
      ${codeBlock(copies.exAgenda, 'exAgenda')}
    </section>

    <section class="lite-card eq-card">
      <h2 class="eq-card-title">Últimos avisos recibidos de ManyChat</h2>
      ${eventsTable()}
    </section>`;

  // ---- Calendly ----
  async function calendlyAction(form, action) {
    const err = form.querySelector('[data-error]');
    err.textContent = '';
    const token = form.token.value.trim();
    if (!token) return (err.textContent = 'Pega el token de Calendly.');
    const buttons = form.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (action === 'conectar') {
        calendly = (await post('/calendly/conectar', { token })).calendly;
        toast('Calendly conectado ✓');
      } else {
        await post('/calendly/desconectar', { token });
        calendly = null;
        toast('Calendly desconectado');
      }
      content.querySelector('[data-calendly-card]').innerHTML = calendlyCard();
    } catch (e2) {
      err.textContent = e2.message;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  // ---- color ----
  let currentColor = normalizeColor(aj.color || DEFAULT_COLOR);
  const themesEl = content.querySelector('[data-themes]');
  const customInput = content.querySelector('[data-custom]');
  function markTheme() {
    let preset = false;
    themesEl.querySelectorAll('[data-color]').forEach((b) => {
      const on_ = b.dataset.color === currentColor;
      preset ||= on_;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-checked', String(on_));
    });
    const custom = themesEl.querySelector('.eq-theme-custom');
    custom.classList.toggle('active', !preset);
    customInput.value = currentColor;
    if (!preset) custom.querySelector('.eq-theme-dot').style.background = currentColor;
  }
  markTheme();
  async function saveColor(c) {
    const before = currentColor;
    currentColor = applyTheme(c, ctx.ajustes?.negocio ?? aj.negocio);
    markTheme();
    try {
      await patch('/ajustes', { color: currentColor });
      if (ctx.ajustes) ctx.ajustes.color = currentColor;
      toast('Color guardado ✓');
    } catch (e2) {
      currentColor = applyTheme(before, ctx.ajustes?.negocio ?? aj.negocio);
      markTheme();
      toast(e2.message);
    }
  }

  const offs = [
    on(content, 'click', '[data-color]', (e, el) => saveColor(el.dataset.color)),
    on(content, 'input', '[data-custom]', (e, el) => {
      // Vista previa mientras se mueve el selector; se guarda al soltarlo.
      applyTheme(el.value);
    }),
    on(content, 'change', '[data-custom]', (e, el) => saveColor(el.value)),
    on(content, 'input', '[data-cal-link]', (e, el) => {
      calLink = el.value;
      try {
        localStorage.setItem(CAL_LINK_KEY, calLink.trim());
      } catch {
        /* sin almacenamiento */
      }
      const box = content.querySelector('[data-setter-links]');
      if (box) box.innerHTML = setterLinks();
    }),
    on(content, 'click', '[data-copy]', (e, el) => copyText(copies[el.dataset.copy] ?? '')),
    on(content, 'submit', '[data-calendly-form]', (e, form) => {
      e.preventDefault();
      calendlyAction(form, 'conectar');
    }),
    on(content, 'click', '[data-calendly-off]', (e, el) => calendlyAction(el.closest('form'), 'desconectar')),
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
