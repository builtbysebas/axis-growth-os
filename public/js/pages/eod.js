// Pantalla «Mi EOD» (/eod), como «Mi reporte» de la versión completa:
// resumen automático del día sacado del CRM, tarjeta grande con la fecha,
// preguntas de sus roles, métricas en vivo mientras escribe, borrador en este
// equipo, historial de 2 semanas y barra fija abajo con «Cargar EOD».
import { get, put } from '../core/api.js';
import { addDays, timeZone, todayStr } from '../core/dates.js';
import { esc, icons, money, num, on, pct } from '../core/dom.js';
import { dxCard, dxHeader, dxSectionLabel, dxTile, dxTiles, loading, toast } from '../core/ui.js';

const HISTORY_DAYS = 14;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ---------------------------------------------------------------- utilidades compartidas (EOD equipo y Metas)
/** Mismo criterio que el servidor: sin tildes, sin mayúsculas, guiones = espacios. */
export function normQ(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const KNOWN = { outbound: 'outbound', respuestasOutbound: 'respuestas a outbound', inbound: 'inbound', followUps: 'follow ups' };

/** Métricas derivadas en vivo a partir del borrador (las 4 preguntas por su texto). */
export function derivedFromAnswers(preguntas, answers, calificadas) {
  const val = (label) => {
    const q = preguntas.find((p) => normQ(p.texto) === label);
    if (!q) return null;
    const v = answers[q.id];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const outbound = val(KNOWN.outbound);
  const resp = val(KNOWN.respuestasOutbound);
  const inbound = val(KNOWN.inbound);
  const nuevas = inbound === null && resp === null ? null : (inbound ?? 0) + (resp ?? 0);
  return {
    outbound,
    respuestasOutbound: resp,
    inbound,
    followUps: val(KNOWN.followUps),
    pctRespuestaOutbound: outbound !== null && outbound > 0 && resp !== null ? (resp / outbound) * 100 : null,
    nuevasConversaciones: nuevas,
    pctConvCalificada: nuevas !== null && nuevas > 0 && calificadas != null ? (calificadas / nuevas) * 100 : null,
  };
}

export function hasKnownQuestions(preguntas) {
  const labels = Object.values(KNOWN);
  return preguntas.some((p) => labels.includes(normQ(p.texto)));
}

/** Respuesta para mostrar (sí/no, número o texto). */
export function formatAnswer(v, tipo) {
  if (v === null || v === undefined || v === '') return '—';
  if (tipo === 'sino' || typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return num(v, 2);
  return String(v);
}

function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
/** «jueves 20 de noviembre» */
export function dayLabel(s) {
  const d = parseDay(s);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
}
function shortDayLabel(s) {
  const d = parseDay(s);
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function hourNow() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timeZone(), hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

/** «a las 21:30» o, si fue otro día, «el 21/11 a las 00:15» (zona del negocio). */
function savedAtLabel(iso, forDate) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  const day = `${g('year')}-${g('month')}-${g('day')}`;
  const time = `${g('hour')}:${g('minute')}`;
  return day === forDate ? `a las ${time}` : `el ${Number(g('day'))}/${Number(g('month'))} a las ${time}`;
}

/** Comparación de respuestas sin importar orden ni vacíos. */
function stable(a) {
  return JSON.stringify(
    Object.entries(a || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .sort(([x], [y]) => x.localeCompare(y)),
  );
}

// Borrador en este equipo (localStorage puede no existir: modo privado).
const draftKey = (uid, fecha) => `ago-eod-draft:${uid}:${fecha}`;
function readDraft(uid, fecha) {
  try {
    const raw = localStorage.getItem(draftKey(uid, fecha));
    return raw ? JSON.parse(raw).answers || null : null;
  } catch {
    return null;
  }
}
function writeDraft(uid, fecha, answers) {
  try {
    localStorage.setItem(draftKey(uid, fecha), JSON.stringify({ answers, at: Date.now() }));
  } catch {
    /* sin almacenamiento: igual se puede cargar */
  }
}
function clearDraft(uid, fecha) {
  try {
    localStorage.removeItem(draftKey(uid, fecha));
  } catch {
    /* nada */
  }
}

// ---------------------------------------------------------------- pantalla
export async function render(root, ctx) {
  const uid = ctx.user.id;
  const roles = ctx.user.roles;
  const today = todayStr();
  const early = hourNow() < 6;

  const st = {
    fecha: early ? addDays(today, -1) : today,
    earlyNotice: early,
    data: null, // respuesta de GET /eod/mio
    answers: {},
    saved: '[]',
    draftRestored: false,
    justSaved: false,
    submitting: false,
    loading: true,
    error: '',
  };
  let token = 0;

  root.innerHTML = `
    <div class="crm-page dx-page dx-page-narrow eq-eod">
      ${dxHeader({ eyebrow: 'Reportes', title: 'Mi EOD' })}
      <div class="dxe-report" data-body>${loading()}</div>
    </div>`;
  const body = root.querySelector('[data-body]');

  async function load(fecha) {
    const my = ++token;
    st.loading = true;
    st.error = '';
    st.justSaved = false;
    root.querySelector('.dxe-body, .dxe-form-card')?.classList.add('dx-dim');
    try {
      const d = await get(`/eod/mio?fecha=${encodeURIComponent(fecha)}`);
      if (my !== token) return;
      st.data = d;
      st.fecha = d.fecha;
      const server = d.respuestas || {};
      st.saved = stable(server);
      const draft = readDraft(uid, d.fecha);
      if (draft && stable(draft) !== st.saved) {
        st.answers = { ...server, ...draft };
        st.draftRestored = true;
      } else {
        if (draft) clearDraft(uid, d.fecha);
        st.answers = { ...server };
        st.draftRestored = false;
      }
    } catch (err) {
      if (my !== token) return;
      if (!st.data) {
        body.innerHTML = `<div class="lite-empty">No se pudo cargar tu EOD: ${esc(err.message)}</div>`;
        return;
      }
      toast(err.message, { error: true });
    } finally {
      if (my === token) st.loading = false;
    }
    if (my === token) draw();
  }

  // ------------------------------------------------------------ piezas
  const preguntas = () => st.data?.preguntas || [];
  const submittedDay = () => (st.data?.historial || []).find((x) => x.fecha === st.fecha) || null;
  const dirty = () => stable(st.answers) !== st.saved;

  function summaryHtml() {
    const r = st.data?.resumen || {};
    const parts = [];
    const both = r.setter && r.closer;
    if (r.setter) {
      const s = r.setter;
      parts.push(`
        ${both ? '<span class="eq-sub-label">Como setter</span>' : ''}
        ${dxTiles(
          dxTile({ index: 1, tone: 'peach', icon: icons.chat, label: 'Propuestas de llamada', value: num(s.propuestas) }) +
            dxTile({ index: 2, tone: 'indigo', icon: icons.link, label: 'Links enviados', value: num(s.links) }) +
            dxTile({ index: 3, tone: 'indigo', icon: icons.calendar, label: 'Agendas', value: num(s.agendas) }) +
            dxTile({ index: 4, tone: 'emerald', icon: icons.check, label: 'Agendas calificadas', value: num(s.calificadas) }),
        )}`);
    }
    if (r.closer) {
      const c = r.closer;
      parts.push(`
        ${both ? '<span class="eq-sub-label">Como closer</span>' : ''}
        ${dxTiles(
          dxTile({ index: 5, tone: 'indigo', icon: icons.phone, label: 'Llamadas del día', value: num(c.llamadas), sub: c.sinResultado ? `${c.sinResultado} sin resultado` : '' }) +
            dxTile({ index: 6, tone: 'peach', icon: icons.check, label: 'Shows', value: num(c.shows), sub: `show rate ${pct(c.showRate)}` }) +
            dxTile({ index: 7, tone: 'emerald', icon: icons.crown, label: 'Ventas', value: num(c.ventas), sub: `close rate ${pct(c.closeRate)}` }) +
            dxTile({ index: 8, tone: 'emerald', icon: icons.money, label: 'Cash collected', value: esc(money(c.cash)) }),
        )}`);
    }
    if (!parts.length) return '';
    return `
      <div class="dxe-body eq-summary">
        ${dxSectionLabel(`Resumen automático · ${dayLabel(st.fecha)}`)}
        <p class="eq-hint">Sale solo de tus agendas en Ventas y de los avisos de ManyChat. No lo tienes que escribir.</p>
        ${parts.join('')}
      </div>`;
  }

  function derivedHtml() {
    const qs = preguntas();
    if (!hasKnownQuestions(qs)) return '';
    const cal = st.data?.resumen?.setter?.calificadas ?? null;
    const d = derivedFromAnswers(qs, st.answers, cal);
    const v = (x) => (x === null ? '—' : num(x));
    return `
      ${dxSectionLabel('De tus respuestas (en vivo)')}
      ${dxTiles(
        dxTile({ index: 1, tone: 'peach', icon: icons.chat, label: 'Outbound', value: v(d.outbound) }) +
          dxTile({ index: 2, tone: 'indigo', icon: icons.link, label: 'Respuestas a Outbound', value: v(d.respuestasOutbound) }) +
          dxTile({ index: 3, tone: 'emerald', icon: icons.trend, label: '% Respuesta Outbound', value: pct(d.pctRespuestaOutbound) }) +
          dxTile({ index: 4, tone: 'indigo', icon: icons.users, label: 'Inbound', value: v(d.inbound) }) +
          dxTile({ index: 5, tone: 'peach', icon: icons.check, label: 'Follow ups', value: v(d.followUps) }) +
          dxTile({ index: 6, tone: 'emerald', icon: icons.users, label: 'Nuevas conversaciones', value: v(d.nuevasConversaciones), sub: 'inbound + respuestas a outbound' }) +
          dxTile({ index: 7, tone: 'indigo', icon: icons.trend, label: '% Conversación → agenda calificada', value: pct(d.pctConvCalificada), sub: cal === null ? '' : `${num(cal)} calificadas ese día` }),
      )}`;
  }

  function dayCardHtml() {
    const sub = submittedDay();
    const yesterday = addDays(today, -1);
    return `
      <div class="dxe-day-anchor" data-day-anchor>
        ${dxCard(
          `<span class="dxe-day-eyebrow">Fecha del EOD que vas a cargar</span>
          <div class="dxe-day-title">
            ${esc(cap(dayLabel(st.fecha)))}
            ${st.fecha === today ? '<span class="dxe-day-tag">Hoy</span>' : ''}
            ${st.fecha === yesterday ? '<span class="dxe-day-tag">Ayer</span>' : ''}
          </div>
          <div class="dxe-day-row">
            <input type="date" aria-label="Fecha del EOD" value="${esc(st.fecha)}" max="${esc(today)}" data-date>
            <button type="button" class="dxe-day-chip${st.fecha === today ? ' active' : ''}" data-pick="${esc(today)}">Hoy</button>
            <button type="button" class="dxe-day-chip${st.fecha === yesterday ? ' active' : ''}" data-pick="${esc(yesterday)}">Ayer</button>
          </div>
          ${st.earlyNotice ? '<p class="dxe-day-note">Como todavía no son las 6 a. m., te dejamos el EOD de ayer. Si es el de hoy, toca «Hoy».</p>' : ''}
          <div class="dxe-day-status ${sub ? 'ok' : 'pending'}">
            ${sub ? `✓ Ya cargaste el EOD de este día (${esc(savedAtLabel(sub.actualizado, st.fecha))})` : 'Todavía no cargaste el EOD de este día'}
          </div>`,
          'dxe-day-card',
        )}
      </div>`;
  }

  function questionHtml(q) {
    const v = st.answers[q.id];
    let input;
    if (q.tipo === 'numero') {
      input = `<input type="number" inputmode="numeric" min="0" step="any" data-q="${esc(q.id)}" value="${typeof v === 'number' ? esc(String(v)) : ''}">`;
    } else if (q.tipo === 'sino') {
      input = `<select data-q="${esc(q.id)}">
        <option value="">Sin responder</option>
        <option value="si" ${v === true ? 'selected' : ''}>Sí</option>
        <option value="no" ${v === false ? 'selected' : ''}>No</option>
      </select>`;
    } else {
      input = `<textarea rows="2" data-q="${esc(q.id)}" maxlength="2000">${esc(typeof v === 'string' ? v : '')}</textarea>`;
    }
    return `<div class="eod-question"><label class="crm-field-label" for="eq-q-${esc(q.id)}">${esc(q.texto)}</label>${input.replace('data-q=', `id="eq-q-${esc(q.id)}" data-q=`)}</div>`;
  }

  function formHtml() {
    const qs = preguntas();
    if (!qs.length) return dxCard('<p class="dxe-empty">Todavía no hay preguntas del EOD para tu rol. Avísale a la administradora.</p>');
    return dxCard(
      `${st.draftRestored ? '<p class="dxe-draft-note">Recuperamos las respuestas que dejaste sin cargar. Revísalas y dale a «Cargar EOD».</p>' : ''}
      <form id="eod-form" class="eod-form" novalidate>${qs.map(questionHtml).join('')}</form>`,
      `dxe-form-card${st.loading ? ' dx-dim' : ''}`,
    );
  }

  function historyRows() {
    const by = new Map((st.data?.historial || []).map((x) => [x.fecha, x]));
    return Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const d = addDays(today, -i);
      const wd = parseDay(d).getUTCDay();
      return { fecha: d, weekend: wd === 0 || wd === 6, sub: by.get(d) || null };
    });
  }

  function historyHtml() {
    if (!preguntas().length) return '';
    const rows = historyRows();
    const workdays = rows.filter((r) => !r.weekend && r.fecha !== today);
    const done = workdays.filter((r) => r.sub).length;
    return `
      <div class="dxe-history-head">
        ${dxSectionLabel('Tus EODs de las últimas 2 semanas')}
        <span class="dxe-history-count">${done} de ${workdays.length} días hábiles cargados</span>
      </div>
      ${dxCard(
        `<ul class="dxe-history">${rows
          .map((r) => {
            const state = r.sub ? 'ok' : r.fecha === today ? 'today' : r.weekend ? 'weekend' : 'missing';
            const text = r.sub
              ? `✓ Cargado ${savedAtLabel(r.sub.actualizado, r.fecha)}`
              : r.fecha === today
                ? 'Pendiente'
                : r.weekend
                  ? 'Fin de semana'
                  : '✕ No cargado';
            return `<li><button type="button" class="dxe-history-row ${state}${r.fecha === st.fecha ? ' selected' : ''}" data-go="${esc(r.fecha)}">
              <span class="dxe-history-day">${esc(cap(shortDayLabel(r.fecha)))}</span>
              <span class="dxe-history-state">${esc(text)}</span>
            </button></li>`;
          })
          .join('')}</ul>`,
        'dxe-history-card',
      )}`;
  }

  function statusText() {
    const sub = submittedDay();
    const isDirty = dirty();
    if (st.submitting) return { text: 'Cargando tu EOD…', tone: '' };
    if (st.error) return { text: st.error, tone: 'pending' };
    if (st.justSaved && !isDirty) return { text: `Listo, tu EOD del ${dayLabel(st.fecha)} quedó cargado ✓`, tone: 'ok' };
    if (isDirty && sub) return { text: 'Cambiaste respuestas: dale a «Cargar EOD» para actualizarlo', tone: 'pending' };
    if (isDirty) return { text: 'Sin cargar todavía (tus respuestas quedan guardadas en este equipo)', tone: 'pending' };
    if (sub) return { text: 'EOD de este día cargado ✓', tone: 'ok' };
    return { text: 'Todavía no cargaste el EOD de este día', tone: 'pending' };
  }

  function savebarHtml() {
    if (!preguntas().length) return '';
    const s = statusText();
    const label = st.submitting ? 'Cargando…' : submittedDay() && !dirty() ? 'Volver a cargar' : 'Cargar EOD';
    return `
      <div class="dxe-savebar" role="status" aria-live="polite">
        <span class="dxe-savebar-text ${s.tone}" data-status>${esc(s.text)}</span>
        <button type="submit" form="eod-form" data-submit ${st.submitting ? 'disabled' : ''}>${esc(label)}</button>
      </div>`;
  }

  function draw() {
    body.innerHTML = `
      ${summaryHtml()}
      <div class="eq-derived" data-derived>${derivedHtml()}</div>
      ${dayCardHtml()}
      ${dxSectionLabel('Tus respuestas')}
      ${formHtml()}
      ${historyHtml()}
      ${savebarHtml()}`;
  }

  /** Solo lo que cambia mientras escribe (no se pierde el foco del campo). */
  function refreshLive() {
    const der = body.querySelector('[data-derived]');
    if (der) der.innerHTML = derivedHtml();
    const bar = body.querySelector('.dxe-savebar');
    if (bar) bar.outerHTML = savebarHtml();
  }

  // ------------------------------------------------------------ eventos
  function pickDate(next) {
    if (!next || next > today) return;
    st.earlyNotice = false;
    st.fecha = next;
    load(next);
  }

  const offs = [
    on(body, 'input', 'input[data-q], textarea[data-q]', (e, el) => {
      const q = preguntas().find((p) => p.id === el.dataset.q);
      if (!q) return;
      let v = null;
      if (q.tipo === 'numero') v = el.value === '' ? null : Number(el.value);
      else if (q.tipo === 'texto') v = el.value === '' ? null : el.value;
      if (q.tipo === 'numero' && v !== null && !Number.isFinite(v)) v = null;
      if (v === null) delete st.answers[q.id];
      else st.answers[q.id] = v;
      writeDraft(uid, st.fecha, st.answers);
      st.justSaved = false;
      st.error = '';
      refreshLive();
    }),
    on(body, 'change', 'select[data-q]', (e, el) => {
      const id = el.dataset.q;
      if (el.value === 'si') st.answers[id] = true;
      else if (el.value === 'no') st.answers[id] = false;
      else delete st.answers[id];
      writeDraft(uid, st.fecha, st.answers);
      st.justSaved = false;
      st.error = '';
      refreshLive();
    }),
    on(body, 'change', '[data-date]', (e, el) => pickDate(el.value)),
    on(body, 'click', '[data-pick]', (e, el) => pickDate(el.dataset.pick)),
    on(body, 'click', '[data-go]', (e, el) => {
      pickDate(el.dataset.go);
      body.querySelector('[data-day-anchor]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
    on(body, 'submit', '#eod-form', (e) => {
      e.preventDefault();
      submit();
    }),
    // El botón de la barra apunta al formulario con form="eod-form"; por si el
    // navegador no lo respeta, también se escucha el clic.
    on(body, 'click', '[data-submit]', (e) => {
      e.preventDefault();
      submit();
    }),
  ];

  async function submit() {
    if (st.submitting) return;
    if (stable(st.answers) === '[]') {
      st.error = 'Completa tus respuestas antes de cargar el EOD.';
      refreshLive();
      return;
    }
    st.submitting = true;
    st.error = '';
    refreshLive();
    const fecha = st.fecha;
    try {
      const r = await put('/eod/mio', { fecha, respuestas: st.answers });
      if (fecha !== st.fecha) return;
      st.data.historial = r.historial;
      st.data.envio = r.envio;
      st.answers = { ...r.respuestas };
      st.saved = stable(r.respuestas);
      clearDraft(uid, fecha);
      st.draftRestored = false;
      st.justSaved = true;
      toast('EOD cargado ✓');
    } catch (err) {
      st.error = `${err.message}. Tus respuestas siguen guardadas en este equipo: intenta de nuevo.`;
      toast(err.message, { error: true });
    } finally {
      st.submitting = false;
    }
    // Repintar todo menos lo que el usuario está escribiendo: la tarjeta de fecha,
    // el historial y la barra cambian; el formulario se conserva.
    const active = document.activeElement?.dataset?.q;
    draw();
    if (active) body.querySelector(`[data-q="${CSS.escape(active)}"]`)?.focus();
  }

  await load(st.fecha);
  return () => offs.forEach((off) => off());
}
