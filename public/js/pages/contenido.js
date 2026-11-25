// Planificador de contenido (como ContentPlannerPageClient de la versión completa).
// Una misma pantalla para 3 rutas: /contenido/corto (posts), /contenido/stories
// (historias) y /contenido/ads (ads, solo admin). Vistas Calendario (Mes/Semana,
// arrastrar un chip a otro día lo reagenda) y Lista. Panel de detalle con el
// código para ManyChat, la atribución automática, recursos, comentarios y guion.
import { del, get, patch, post } from '../core/api.js';
import { addDays, todayStr, weekStart } from '../core/dates.js';
import { esc, fmtDate, fmtDateTime, money, norm } from '../core/dom.js';
import { enableDrag, isDragging } from '../core/dnd.js';
import { attempt, confirmDialog, createButton, loading, sidePanel, toast, viewToggle, waveText } from '../core/ui.js';

const KIND_BY_PATH = { '/contenido/corto': 'post', '/contenido/stories': 'story', '/contenido/ads': 'ad' };

const ESTADOS = ['idea', 'guion', 'grabado', 'editado', 'programado', 'publicado'];
const ESTADOS_AD = ['activo', 'pausado', 'terminado'];
const ESTADO_LABEL = {
  idea: 'Idea',
  guion: 'Guion',
  grabado: 'Grabado',
  editado: 'Editado',
  programado: 'Programado',
  publicado: 'Publicado',
  activo: 'Activo',
  pausado: 'Pausado',
  terminado: 'Terminado',
};
const ESTADO_TONE = { publicado: 'green', programado: 'indigo', editado: 'orange', activo: 'green', pausado: 'amber' };
const FORMATOS = ['Reel', 'Carrusel animado', 'Carrusel con foto', 'Carrusel caso de éxito', 'Foto', 'Video largo'];
const TIPOS_STORY = ['Poll', 'CTA', 'Q&A', 'Recurso Gratis', 'Encuesta', 'Caja de preguntas', 'Libre'];

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const pad = (n) => String(n).padStart(2, '0');
const isAnuncio = (it) => String(it.etiqueta || '').trim().toLowerCase() === 'anuncio';
const safeHref = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function copyText(textValue, btn, label) {
  const done = () => {
    if (!btn) return;
    btn.textContent = 'Copiado ✓';
    setTimeout(() => (btn.textContent = label), 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(textValue).then(done, () => fallback());
  else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = textValue;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      toast('No se pudo copiar', { error: true });
    }
    ta.remove();
  }
}

function itemNoun(kind) {
  return kind === 'story' ? 'historia' : kind === 'ad' ? 'ad' : 'contenido';
}

export async function render(root, ctx) {
  const kind = KIND_BY_PATH[ctx.page.path] || 'post';
  const isAdmin = ctx.isAdmin;
  const today = todayStr();
  const state = {
    items: [],
    angulos: [],
    recursos: [],
    view: ctx.params.get('vista') === 'lista' || ctx.params.get('vista') === 'calendario' ? ctx.params.get('vista') : kind === 'ad' ? 'lista' : 'calendario',
    sub: 'month',
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
    week: weekStart(today),
  };
  let panel = null; // panel abierto (detalle o crear)
  const cleanups = [];

  root.innerHTML = `
    <div class="crm-page dx-page content-planner">
      <div class="crm-toolbar">
        <div>
          <span class="crm-eyebrow">Contenido</span>
          <h1>${esc(ctx.page.title)}</h1>
        </div>
        <div class="crm-toolbar-actions">
          <span class="save-status" data-saved>Guardado ✓</span>
          <span data-views></span>
          ${isAdmin ? createButton('Crear', 'data-create') : ''}
        </div>
      </div>
      <div data-body>${loading()}</div>
    </div>`;
  const body = root.querySelector('[data-body]');
  const savedEl = root.querySelector('[data-saved]');

  function flashSaved() {
    savedEl.classList.add('show');
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => savedEl.classList.remove('show'), 1200);
  }

  function renderViews() {
    root.querySelector('[data-views]').innerHTML = viewToggle(
      [
        { key: 'calendario', label: 'Calendario' },
        { key: 'lista', label: 'Lista' },
      ],
      state.view,
    );
  }

  // ------------------------------------------------------------ datos
  const data = await attempt(() => get(`/contenido?kind=${kind}`));
  if (!data) {
    body.innerHTML = `<div class="lite-empty">No se pudo cargar el contenido. Recarga la página para intentar de nuevo.</div>`;
    return;
  }
  state.items = data.items;
  state.angulos = data.angulos;
  state.recursos = data.recursos;
  renderViews();
  renderBody();

  function replaceItem(it) {
    const i = state.items.findIndex((x) => x.id === it.id);
    const { guion, ...rest } = it;
    if (i >= 0) state.items[i] = { ...state.items[i], ...rest };
    else state.items.push(rest);
  }

  function refresh() {
    if (isDragging()) return;
    renderBody();
  }

  // ------------------------------------------------------------ vistas
  function renderBody() {
    body.innerHTML = state.view === 'lista' ? listHtml() : calendarHtml();
  }

  function itemsByDay() {
    const map = new Map();
    for (const it of state.items) {
      if (!it.fecha) continue;
      if (!map.has(it.fecha)) map.set(it.fecha, []);
      map.get(it.fecha).push(it);
    }
    return map;
  }

  function chipHtml(it) {
    return `
      <div class="content-calendar-chip-row">
        <div class="content-calendar-chip${isAnuncio(it) ? ' tone-amber' : ''}${isAdmin ? '' : ' content-chip-readonly'}" role="button" tabindex="0"
             data-item="${esc(it.id)}" title="${esc(it.codigo)}${it.leads > 0 ? ` · ${it.leads} leads` : ''}">
          <span class="content-calendar-chip-text">${esc(it.titulo)}</span>
          ${it.leads > 0 ? `<span class="content-calendar-chip-leads">${it.leads}</span>` : ''}
        </div>
        ${isAdmin ? `<button type="button" class="content-calendar-chip-delete" title="Eliminar" aria-label="Eliminar" data-del="${esc(it.id)}">✕</button>` : ''}
      </div>`;
  }

  function cellHtml(day, items, { outside = false, tall = false, hideNum = false } = {}) {
    const cls = ['content-calendar-cell'];
    if (day === today) cls.push('today');
    if (outside) cls.push('outside');
    if (tall) cls.push('tall');
    if (!isAdmin) cls.push('content-cell-readonly');
    return `
      <div class="${cls.join(' ')}" data-day="${day}">
        ${hideNum ? '' : `<span class="content-calendar-daynum">${Number(day.slice(8))}</span>`}
        <div class="content-calendar-items">
          ${items.map(chipHtml).join('')}
          ${items.length && isAdmin ? `<button type="button" class="content-calendar-add" data-add="${day}">+ agregar</button>` : ''}
        </div>
      </div>`;
  }

  function calendarHtml() {
    const byDay = itemsByDay();
    let nav;
    let grid;
    if (state.sub === 'month') {
      const first = `${state.year}-${pad(state.month)}-01`;
      const lead = (new Date(Date.UTC(state.year, state.month - 1, 1)).getUTCDay() + 6) % 7;
      const days = new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();
      const count = Math.ceil((lead + days) / 7) * 7;
      const start = addDays(first, -lead);
      const cells = Array.from({ length: count }, (_, i) => addDays(start, i));
      nav = `
        <button type="button" data-nav="-1" aria-label="Mes anterior">‹</button>
        <span class="content-calendar-month">${MONTHS[state.month - 1]} ${state.year}</span>
        <button type="button" data-nav="1" aria-label="Mes siguiente">›</button>`;
      grid = `
        <div class="content-calendar-grid content-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="content-calendar-grid content-calendar-days">
          ${cells.map((d) => cellHtml(d, byDay.get(d) || [], { outside: Number(d.slice(5, 7)) !== state.month })).join('')}
        </div>`;
    } else {
      const days = Array.from({ length: 7 }, (_, i) => addDays(state.week, i));
      const a = days[0];
      const b = days[6];
      const [ay, am, ad] = a.split('-').map(Number);
      const [by, bm, bd] = b.split('-').map(Number);
      const label =
        am === bm ? `${ad} – ${bd} de ${MONTHS[am - 1]} ${ay}` : `${ad} ${MONTHS_SHORT[am - 1]} – ${bd} ${MONTHS_SHORT[bm - 1]} ${by}`;
      nav = `
        <button type="button" data-nav="-1" aria-label="Semana anterior">‹</button>
        <span class="content-calendar-month">${label}</span>
        <button type="button" data-nav="1" aria-label="Semana siguiente">›</button>`;
      grid = `
        <div class="content-calendar-week">
          ${days
            .map(
              (d, i) => `
            <div class="content-calendar-week-col">
              <span class="content-calendar-week-daylabel">${WEEKDAYS[i]} ${Number(d.slice(8))}</span>
              ${cellHtml(d, byDay.get(d) || [], { tall: true, hideNum: true })}
            </div>`,
            )
            .join('')}
        </div>`;
    }
    const sinFecha = state.items.filter((it) => !it.fecha).length;
    return `
      <div class="content-calendar">
        <div class="content-calendar-nav">
          ${nav}
          <button type="button" class="content-calendar-today" data-today>Hoy</button>
          <div class="content-calendar-subview-toggle" role="tablist" aria-label="Vista del calendario">
            <button type="button" role="tab" data-sub="month" class="${state.sub === 'month' ? 'active' : ''}">Mes</button>
            <button type="button" role="tab" data-sub="week" class="${state.sub === 'week' ? 'active' : ''}">Semana</button>
          </div>
        </div>
        ${grid}
        ${sinFecha ? `<p class="content-code-hint">${plural(sinFecha, 'contenido sin fecha', 'contenidos sin fecha')}: míralos en la vista Lista.</p>` : ''}
      </div>`;
  }

  function listHtml() {
    const sorted = [...state.items].sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999') || String(a.creado).localeCompare(String(b.creado)));
    const third = kind === 'post' ? 'Formato' : kind === 'story' ? 'Tipo de story' : null;
    const cols = 8 + (third ? 1 : 0) + (kind === 'ad' ? 1 : 0) + (isAdmin ? 1 : 0) - 1;
    return `
      <div class="clients-table-wrap content-list-wrap">
        <table class="clients-table content-list-table">
          <thead>
            <tr>
              <th>Fecha</th><th>Título</th><th>Código</th><th>Estado</th>
              ${third ? `<th>${third}</th>` : ''}
              <th>Ángulo</th><th class="num">Leads</th><th class="num">Agendas</th>
              ${kind === 'ad' ? '<th class="num">Gasto</th>' : ''}
              ${isAdmin ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${
              sorted.length
                ? sorted
                    .map(
                      (it) => `
              <tr data-item="${esc(it.id)}">
                <td class="content-list-date">${it.fecha ? esc(fmtDate(it.fecha)) : '—'}</td>
                <td class="clients-table-name">${isAnuncio(it) ? '<span class="content-dot-amber" title="Anuncio"></span>' : ''}${esc(it.titulo)}</td>
                <td><code class="content-code-inline">${esc(it.codigo)}</code></td>
                <td><span class="lite-pill ${ESTADO_TONE[it.estado] || ''}">${esc(ESTADO_LABEL[it.estado] || it.estado)}</span></td>
                ${third ? `<td>${esc((kind === 'post' ? it.formato : it.tipo_story) || '—')}</td>` : ''}
                <td>${esc(it.angulo_nombre || '—')}</td>
                <td class="num">${it.leads || '—'}</td>
                <td class="num">${it.agendas || '—'}</td>
                ${kind === 'ad' ? `<td class="num">${it.gasto !== '' ? money(it.gasto) : '—'}</td>` : ''}
                ${isAdmin ? `<td><button type="button" class="content-list-delete" title="Eliminar" aria-label="Eliminar" data-del="${esc(it.id)}">✕</button></td>` : ''}
              </tr>`,
                    )
                    .join('')
                : `<tr><td colspan="${cols}" class="clients-table-empty">${
                    kind === 'story' ? 'Todavía no hay historias planificadas' : kind === 'ad' ? 'Todavía no hay ads planificados' : 'Todavía no hay contenido planificado'
                  }${isAdmin ? ' — crea el primero con «Crear».' : '.'}</td></tr>`
            }
          </tbody>
        </table>
      </div>`;
  }

  // ------------------------------------------------------------ eventos de la página
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const viewBtn = t.closest('[data-view]');
    if (viewBtn) {
      state.view = viewBtn.dataset.view;
      ctx.setParams({ vista: state.view === (kind === 'ad' ? 'lista' : 'calendario') ? null : state.view });
      renderViews();
      renderBody();
      return;
    }
    if (t.closest('[data-create]')) return openCreate();
    const delBtn = t.closest('[data-del]');
    if (delBtn) {
      e.stopPropagation();
      return removeItem(delBtn.dataset.del);
    }
    const addBtn = t.closest('[data-add]');
    if (addBtn) return openCreate(addBtn.dataset.add);
    const itemEl = t.closest('[data-item]');
    if (itemEl) return openItem(itemEl.dataset.item);
    const navBtn = t.closest('[data-nav]');
    if (navBtn) {
      const d = Number(navBtn.dataset.nav);
      if (state.sub === 'month') {
        const m = state.month - 1 + d;
        state.year += Math.floor(m / 12);
        state.month = ((m % 12) + 12) % 12 + 1;
      } else state.week = addDays(state.week, 7 * d);
      return renderBody();
    }
    if (t.closest('[data-today]')) {
      state.year = Number(today.slice(0, 4));
      state.month = Number(today.slice(5, 7));
      state.week = weekStart(today);
      return renderBody();
    }
    const subBtn = t.closest('[data-sub]');
    if (subBtn) {
      state.sub = subBtn.dataset.sub;
      // Al pasar a Semana, la semana del día 1 del mes que se estaba viendo (o la de hoy).
      if (state.sub === 'week') {
        const sameMonth = Number(today.slice(0, 4)) === state.year && Number(today.slice(5, 7)) === state.month;
        state.week = weekStart(sameMonth ? today : `${state.year}-${pad(state.month)}-01`);
      } else {
        state.year = Number(state.week.slice(0, 4));
        state.month = Number(state.week.slice(5, 7));
      }
      return renderBody();
    }
    const cell = t.closest('.content-calendar-cell[data-day]');
    if (cell && isAdmin && !cell.querySelector('[data-item]')) openCreate(cell.dataset.day);
  });
  root.addEventListener('keydown', (e) => {
    const itemEl = e.target instanceof Element ? e.target.closest('.content-calendar-chip[data-item]') : null;
    if (itemEl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openItem(itemEl.dataset.item);
    }
  });

  // Arrastrar un chip a otro día lo reagenda (solo admin).
  if (isAdmin) {
    cleanups.push(
      enableDrag(body, {
        item: '.content-calendar-chip[data-item]',
        zone: '.content-calendar-cell[data-day]',
        overlayClass: 'content-calendar-chip-overlay',
        onDrop: ({ item, zone }) => reschedule(item.dataset.item, zone.dataset.day),
      }),
    );
  }

  async function reschedule(id, day) {
    const it = state.items.find((x) => x.id === id);
    if (!it || !day || it.fecha === day) return;
    const prev = it.fecha;
    it.fecha = day;
    renderBody();
    const r = await attempt(() => patch(`/contenido/${id}`, { fecha: day }));
    if (!r) {
      it.fecha = prev;
      refresh();
      return;
    }
    replaceItem(r.item);
    if (r.aviso) toast(r.aviso, { ms: 6000 });
    flashSaved();
    refresh();
    if (panel?.itemId === id) panel.update(r.item);
  }

  async function removeItem(id) {
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    const extra = it.leads > 0 ? `\n\nTiene ${plural(it.leads, 'lead', 'leads')} de ManyChat: esos avisos quedan en «Sin match».` : '';
    const ok = await confirmDialog(`¿Eliminar «${it.titulo}»? Esto no se puede deshacer.${extra}`, { ok: 'Eliminar', danger: true, title: `Eliminar ${itemNoun(kind)}` });
    if (!ok) return;
    const r = await attempt(() => del(`/contenido/${id}`));
    if (!r) return;
    state.items = state.items.filter((x) => x.id !== id);
    if (panel?.itemId === id) panel.close();
    flashSaved();
    refresh();
  }

  // ------------------------------------------------------------ crear
  function openCreate(day) {
    if (!isAdmin) return;
    panel?.close();
    const p = sidePanel(kind === 'story' ? 'Nueva historia' : kind === 'ad' ? 'Nuevo ad' : 'Nuevo contenido');
    panel = { close: p.close, itemId: null };
    p.body.innerHTML = `
      <form class="lite-form content-create-form" novalidate>
        <div class="crm-field">
          <label class="crm-field-label" for="cc-titulo">${kind === 'ad' ? 'Nombre del ad' : 'Título'}</label>
          <input id="cc-titulo" name="titulo" maxlength="300" placeholder="${kind === 'ad' ? 'Ej. Calculadora - Reel 1' : 'Ej. Calculadora de macros'}" autocomplete="off">
        </div>
        <div class="crm-field">
          <label class="crm-field-label" for="cc-cta">CTA (palabra que la gente comenta o escribe)</label>
          <input id="cc-cta" name="cta" maxlength="120" placeholder="Ej. Calculadora" autocomplete="off">
        </div>
        <div class="crm-field">
          <label class="crm-field-label" for="cc-fecha">${kind === 'ad' ? 'Fecha de lanzamiento' : 'Fecha'}</label>
          <input id="cc-fecha" name="fecha" type="date" value="${esc(day || today)}">
        </div>
        <div class="crm-field">
          <label class="crm-field-label" for="cc-angulo">Ángulo</label>
          <select id="cc-angulo" name="angulo_id">${angleOptions('')}</select>
        </div>
        ${
          kind === 'post'
            ? `<div class="crm-field"><label class="crm-field-label" for="cc-formato">Formato</label>
                 <select id="cc-formato" name="formato"><option value="">Sin definir</option>${FORMATOS.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>`
            : kind === 'story'
              ? `<div class="crm-field"><label class="crm-field-label" for="cc-tipo">Tipo de story</label>
                 <select id="cc-tipo" name="tipo_story"><option value="">Sin definir</option>${TIPOS_STORY.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>`
              : `<div class="crm-field"><label class="crm-field-label" for="cc-gasto">Gasto (USD)</label>
                 <input id="cc-gasto" name="gasto" inputmode="decimal" placeholder="0"></div>`
        }
        <p class="content-code-hint">El código para pegar en ManyChat se arma solo con el tipo, el CTA (o el título si no hay CTA) y la fecha. Lo vas a ver apenas guardes.</p>
        <p class="lite-error" data-err></p>
        <button type="submit" class="crm-create-btn content-create-submit">${waveText('Crear')}</button>
      </form>`;
    const form = p.body.querySelector('form');
    const err = p.body.querySelector('[data-err]');
    setTimeout(() => form.titulo.focus(), 50);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const fd = Object.fromEntries(new FormData(form));
      if (!String(fd.titulo || '').trim()) return (err.textContent = 'Escribe el título.');
      if (!fd.fecha) return (err.textContent = 'Elige la fecha.');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await post('/contenido', { kind, ...fd, angulo_id: fd.angulo_id || null });
        state.items.push(r.item);
        p.close();
        flashSaved();
        toast(`Creado: ${r.item.codigo}`);
        refresh();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  function angleOptions(selected) {
    return `<option value="">Sin ángulo</option>${state.angulos
      .map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.nombre)}</option>`)
      .join('')}`;
  }

  // ------------------------------------------------------------ detalle
  async function openItem(id) {
    panel?.close();
    const base = state.items.find((x) => x.id === id);
    const p = sidePanel(base?.titulo || 'Contenido', {
      wide: true,
      onClose: () => {
        detail.flush();
        detail.destroy();
        if (panel === handle) panel = null;
        ctx.setParams({ item: null });
      },
    });
    const detail = { flush() {}, destroy() {} };
    const handle = { close: p.close, itemId: id, update: () => {} };
    panel = handle;
    ctx.setParams({ item: id });
    p.body.innerHTML = loading();
    let d;
    try {
      d = await get(`/contenido/${id}`);
    } catch (ex) {
      p.body.innerHTML = `<div class="lite-empty">${esc(ex.message)}</div>`;
      return;
    }
    if (panel !== handle) return;
    Object.assign(detail, buildDetail(p, d, handle));
  }

  function buildDetail(p, d, handle) {
    let item = d.item;
    let linked = d.recursos;
    let notas = d.notas;
    let queue = Promise.resolve();
    let guionTimer = 0;
    let guionDirty = false;
    let closed = false;
    const removers = [];

    // Guardado en fila (para que dos cambios seguidos no se pisen).
    function save(fields) {
      queue = queue.then(async () => {
        try {
          const r = await patch(`/contenido/${item.id}`, fields);
          item = { ...item, ...r.item };
          replaceItem(r.item);
          if (r.aviso) toast(r.aviso, { ms: 6500 });
          flashSaved();
          if (!closed) paintHeader();
          refresh();
          return r;
        } catch (ex) {
          toast(ex.message, { error: true });
          // Volver a lo que tiene guardado el servidor.
          try {
            const fresh = await get(`/contenido/${item.id}`);
            item = fresh.item;
            replaceItem(fresh.item);
            refresh();
          } catch {
            /* se queda como estaba */
          }
          if (!closed) paintHeader();
          return null;
        }
      });
      return queue;
    }

    const field = (label, inner, hint = '') =>
      `<div class="crm-field"><span class="crm-field-label">${esc(label)}</span>${inner}${hint ? `<small class="content-field-hint">${hint}</small>` : ''}</div>`;
    const value = (v) => `<span class="crm-field-value">${v ? esc(v) : '—'}</span>`;
    const editable = (key, v, { type = 'text', placeholder = '' } = {}) =>
      isAdmin
        ? `<span class="editable crm-field-value content-editable" role="button" tabindex="0" data-edit="${key}" data-type="${type}" data-placeholder="${esc(placeholder)}">${v ? esc(v) : '<span class="content-empty-val">— tocar para escribir</span>'}</span>`
        : value(v);
    const select = (key, options, selected, empty = 'Sin definir') =>
      `<select data-field="${key}"><option value="">${esc(empty)}</option>${options
        .map((o) => (typeof o === 'string' ? { v: o, l: o } : o))
        .map((o) => `<option value="${esc(o.v)}" ${o.v === selected ? 'selected' : ''}>${esc(o.l)}</option>`)
        .join('')}</select>`;

    p.body.innerHTML = `
      <div class="content-code-block">
        <span class="crm-field-label">Código para ManyChat</span>
        <div class="content-code-row">
          <code data-code></code>
          <button type="button" data-copy-code>Copiar</button>
        </div>
        <p class="content-code-hint">${
          kind === 'ad'
            ? 'Pega este código en el campo <strong>contentCode</strong> del «External Request» de la automatización de ManyChat de este ad.'
            : `Pega este código en el campo <strong>contentCode</strong> del «External Request» de la automatización de ManyChat de ${kind === 'story' ? 'esta historia' : 'este contenido'}.`
        } Se arma solo con el CTA (o el título) y la fecha.</p>
      </div>
      <div class="content-stats" data-stats></div>
      <div data-fields></div>
      <span class="content-section-label">Recursos vinculados</span>
      <div data-recursos></div>
      <span class="content-section-label">Guion</span>
      <div data-guion></div>
      <span class="content-section-label">Comentarios</span>
      <div class="crm-notes" data-notas></div>
      ${isAdmin ? `<button type="button" class="crm-delete-btn" data-delete-item>Eliminar ${itemNoun(kind)}</button>` : ''}`;

    const $ = (s) => p.body.querySelector(s);

    function paintHeader() {
      $('[data-code]').textContent = item.codigo;
      p.setTitle(item.titulo || 'Contenido');
      const gasto = Number(item.gasto);
      const cpl = kind === 'ad' && item.gasto !== '' && item.leads > 0 ? money(gasto / item.leads) : null;
      $('[data-stats]').innerHTML = `
        <div class="content-stat"><span>Leads</span><strong>${item.leads}</strong></div>
        <div class="content-stat"><span>Agendas</span><strong>${item.agendas}</strong></div>
        <div class="content-stat"><span>Ventas</span><strong>${item.ventas}</strong></div>
        <div class="content-stat"><span>Cash</span><strong>${money(item.cash)}</strong></div>
        ${cpl ? `<div class="content-stat"><span>Costo por lead</span><strong>${cpl}</strong></div>` : ''}
        <p class="content-stats-hint">Automático: leads = personas distintas que respondieron por ManyChat con este código; agendas = las que vinieron de este ${itemNoun(kind)} (atribución manual o el último contenido antes de agendar).</p>`;
      // Título y valores que el servidor pudo cambiar (ej. prefijo de carrusel).
      if (!p.body.querySelector('.content-edit-input')) paintFields();
    }

    function paintFields() {
      const estados = (kind === 'ad' ? ESTADOS_AD : ESTADOS).map((v) => ({ v, l: ESTADO_LABEL[v] }));
      const linkHref = safeHref(item.link);
      $('[data-fields]').innerHTML = `
        ${field(kind === 'ad' ? 'Nombre del ad' : 'Título', editable('titulo', item.titulo))}
        <div class="lite-grid2">
          ${field('CTA', editable('cta', item.cta, { placeholder: 'Ej. Calculadora' }), 'Palabra que la gente comenta o escribe')}
          ${field('Fecha', isAdmin ? `<input type="date" data-field="fecha" value="${esc(item.fecha)}">` : value(item.fecha ? fmtDate(item.fecha) : ''))}
          ${field('Estado', isAdmin ? select('estado', estados, item.estado).replace('<option value="">Sin definir</option>', '') : value(ESTADO_LABEL[item.estado] || item.estado))}
          ${field('Ángulo', isAdmin ? `<select data-field="angulo_id">${angleOptions(item.angulo_id)}</select>` : value(item.angulo_nombre))}
          ${
            kind === 'post'
              ? field('Formato', isAdmin ? select('formato', FORMATOS, item.formato) : value(item.formato))
              : kind === 'story'
                ? field('Tipo de story', isAdmin ? select('tipo_story', TIPOS_STORY, item.tipo_story) : value(item.tipo_story))
                : field('Gasto (USD)', isAdmin ? editable('gasto', item.gasto !== '' ? String(Number(item.gasto)) : '', { type: 'number' }) : value(item.gasto !== '' ? money(item.gasto) : ''))
          }
          ${field('Etiqueta', editable('etiqueta', item.etiqueta, { placeholder: 'Ej. Anuncio' }), isAdmin ? 'Escribe «Anuncio» para que salga en ámbar en el calendario.' : '')}
        </div>
        ${field('Gancho', editable('gancho', item.gancho))}
        ${field(
          'Link',
          editable('link', item.link, { type: 'url', placeholder: 'https://…' }) +
            (linkHref ? `<a class="content-open-link" href="${esc(linkHref)}" target="_blank" rel="noopener noreferrer">Abrir link ↗</a>` : ''),
        )}`;
    }

    function paintRecursos() {
      const box = $('[data-recursos]');
      box.innerHTML = `
        ${linked.length ? '' : '<p class="crm-notes-empty">Sin recursos vinculados.</p>'}
        <div class="content-linked-resources">
          ${linked
            .map((r) => {
              const href = safeHref(r.link);
              return `
            <div class="content-linked-resource">
              <span class="content-linked-resource-name">${esc(r.nombre)}</span>
              ${href ? `<a class="content-linked-resource-url" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(r.link)}</a>` : '<span class="content-linked-resource-url">Sin link</span>'}
              ${href ? `<button type="button" data-copy-link="${esc(r.link)}">Copiar link</button>` : ''}
              ${isAdmin ? `<button type="button" class="content-linked-resource-remove" title="Quitar" aria-label="Quitar" data-unlink="${esc(r.id)}">×</button>` : ''}
            </div>`;
            })
            .join('')}
        </div>
        ${
          isAdmin
            ? `<div class="relation-picker" data-picker>
                 <button type="button" class="relation-picker-trigger" data-picker-toggle>+ Vincular recurso</button>
               </div>`
            : ''
        }`;
    }

    // Buscador tipo «Relation» de Notion (RelationPicker de la versión completa).
    let pickerOpen = false;
    function openPicker() {
      const wrap = $('[data-picker]');
      if (!wrap || pickerOpen) return;
      pickerOpen = true;
      const pop = document.createElement('div');
      pop.className = 'relation-picker-popover';
      pop.innerHTML = `<input type="text" placeholder="Buscar recurso…" data-picker-q><div class="relation-picker-options" data-picker-options></div>`;
      wrap.appendChild(pop);
      const input = pop.querySelector('input');
      const paintOptions = () => {
        const q = norm(input.value.trim());
        const linkedIds = new Set(linked.map((r) => r.id));
        const opts = state.recursos.filter((r) => !linkedIds.has(r.id) && (!q || norm(r.nombre).includes(q)));
        pop.querySelector('[data-picker-options]').innerHTML = opts.length
          ? opts
              .map(
                (r) => `<button type="button" class="relation-picker-option" data-link-recurso="${esc(r.id)}">
                  <span class="relation-picker-option-label">${esc(r.nombre)}</span>
                  ${r.link ? `<span class="relation-picker-option-sub">${esc(r.link)}</span>` : ''}
                </button>`,
              )
              .join('')
          : `<p class="relation-picker-empty">${state.recursos.length ? 'No hay más recursos para vincular.' : 'Todavía no hay recursos: créalos en Recursos y Ángulos.'}</p>`;
      };
      input.addEventListener('input', paintOptions);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closePicker();
        }
      });
      pop.addEventListener('click', async (e) => {
        const opt = e.target.closest('[data-link-recurso]');
        if (!opt) return;
        opt.disabled = true;
        const r = await attempt(() => post(`/contenido/${item.id}/recursos`, { recurso_id: opt.dataset.linkRecurso }));
        if (r) {
          linked = r.recursos;
          syncRecursoIds();
          // Repintar la lista sin cerrar el buscador (se pueden vincular varios seguidos).
          const keep = pop;
          paintRecursos();
          $('[data-picker]').appendChild(keep);
          input.value = '';
          paintOptions();
          input.focus();
          flashSaved();
        } else opt.disabled = false;
      });
      paintOptions();
      setTimeout(() => input.focus(), 0);
      const outside = (e) => {
        if (!e.target.closest('[data-picker]')) closePicker();
      };
      document.addEventListener('mousedown', outside);
      closePicker.off = () => document.removeEventListener('mousedown', outside);
    }
    function closePicker() {
      if (!pickerOpen) return;
      pickerOpen = false;
      closePicker.off?.();
      p.body.querySelector('.relation-picker-popover')?.remove();
    }

    function syncRecursoIds() {
      item.recurso_ids = linked.map((r) => r.id);
      replaceItem({ id: item.id, recurso_ids: item.recurso_ids });
    }

    function paintGuion() {
      const box = $('[data-guion]');
      if (isAdmin) {
        box.innerHTML = `
          <textarea class="content-guion" data-guion-input placeholder="Escribe el guion: gancho, desarrollo y cierre…"></textarea>
          <span class="content-guion-status" data-guion-status></span>`;
        const ta = box.querySelector('textarea');
        ta.value = item.guion || '';
        const status = box.querySelector('[data-guion-status]');
        const grow = () => {
          ta.style.height = 'auto';
          ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 220), 900)}px`;
        };
        grow();
        ta.addEventListener('input', () => {
          grow();
          guionDirty = true;
          status.textContent = 'Sin guardar…';
          clearTimeout(guionTimer);
          guionTimer = setTimeout(saveGuion, 900);
        });
        ta.addEventListener('blur', () => guionDirty && saveGuion());
      } else {
        box.innerHTML = item.guion ? `<div class="content-guion-view">${esc(item.guion)}</div>` : '<p class="crm-notes-empty">Sin guion todavía.</p>';
      }
    }
    function saveGuion() {
      clearTimeout(guionTimer);
      if (!guionDirty) return;
      guionDirty = false;
      const ta = p.body.querySelector('[data-guion-input]');
      const status = p.body.querySelector('[data-guion-status]');
      const textValue = ta ? ta.value : item.guion;
      item.guion = textValue;
      if (status) status.textContent = 'Guardando…';
      save({ guion: textValue }).then((r) => {
        const st = p.body.querySelector('[data-guion-status]');
        if (st && !guionDirty) st.textContent = r ? 'Guardado ✓' : 'No se guardó';
      });
    }

    function paintNotas() {
      const box = $('[data-notas]');
      box.innerHTML = `
        ${
          isAdmin
            ? `<form class="crm-add-note-form" data-note-form>
                 <textarea rows="2" maxlength="5000" placeholder="Agregar un comentario…"></textarea>
                 <button type="submit">Comentar</button>
               </form>`
            : ''
        }
        ${notas.length ? '' : '<p class="crm-notes-empty">Sin comentarios todavía.</p>'}
        ${notas
          .map(
            (n) => `
          <div class="crm-note">
            <div class="crm-note-meta"><span>${esc(n.autor || '—')}</span><span>${esc(fmtDateTime(n.creado))}</span></div>
            <p>${esc(n.texto)}</p>
          </div>`,
          )
          .join('')}`;
    }

    // Edición en línea (como EditableField de la versión completa).
    function startEdit(span) {
      const key = span.dataset.edit;
      const type = span.dataset.type;
      const current = key === 'gasto' ? (item.gasto !== '' ? String(Number(item.gasto)) : '') : item[key] || '';
      const input = document.createElement('input');
      input.className = 'content-edit-input';
      input.type = type === 'number' ? 'text' : type;
      if (type === 'number') input.inputMode = 'decimal';
      input.value = current;
      input.placeholder = span.dataset.placeholder || '';
      span.replaceWith(input);
      input.focus();
      let done = false;
      const commit = (cancel = false) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (cancel || v === String(current).trim()) return paintFields();
        if (key === 'titulo' && !v) {
          toast('El título no puede quedar vacío', { error: true });
          return paintFields();
        }
        item[key] = v;
        paintFields();
        save({ [key]: v === '' && key === 'gasto' ? null : v });
      };
      input.addEventListener('blur', () => commit());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          commit(true);
        }
      });
    }

    p.body.addEventListener('click', async (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      const copyCode = t.closest('[data-copy-code]');
      if (copyCode) return copyText(item.codigo, copyCode, 'Copiar');
      const copyLink = t.closest('[data-copy-link]');
      if (copyLink) return copyText(copyLink.dataset.copyLink, copyLink, 'Copiar link');
      const edit = t.closest('[data-edit]');
      if (edit && isAdmin) return startEdit(edit);
      if (t.closest('[data-picker-toggle]')) return pickerOpen ? closePicker() : openPicker();
      const unlink = t.closest('[data-unlink]');
      if (unlink) {
        unlink.disabled = true;
        const r = await attempt(() => del(`/contenido/${item.id}/recursos/${unlink.dataset.unlink}`));
        if (r) {
          linked = r.recursos;
          syncRecursoIds();
          closePicker();
          paintRecursos();
          flashSaved();
        } else unlink.disabled = false;
        return;
      }
      if (t.closest('[data-delete-item]')) return removeItem(item.id);
    });
    p.body.addEventListener('keydown', (e) => {
      const edit = e.target instanceof Element ? e.target.closest('[data-edit]') : null;
      if (edit && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        startEdit(edit);
      }
    });
    p.body.addEventListener('change', (e) => {
      const el = e.target.closest?.('[data-field]');
      if (!el) return;
      const key = el.dataset.field;
      if (key === 'fecha' && !el.value) return;
      const v = el.value;
      item[key] = v;
      if (key === 'angulo_id') item.angulo_nombre = state.angulos.find((a) => a.id === v)?.nombre || '';
      save({ [key]: key === 'angulo_id' ? v || null : v });
    });
    p.body.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-note-form]');
      if (!form) return;
      e.preventDefault();
      const ta = form.querySelector('textarea');
      const textValue = ta.value.trim();
      if (!textValue) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      const r = await attempt(() => post(`/contenido/${item.id}/notas`, { texto: textValue }));
      btn.disabled = false;
      if (!r) return;
      notas = [r.nota, ...notas];
      paintNotas();
      flashSaved();
    });

    paintFields();
    paintHeader();
    paintRecursos();
    paintGuion();
    paintNotas();

    handle.update = (it) => {
      item = { ...item, ...it };
      paintHeader();
      paintFields();
    };
    removers.push(() => closePicker());

    return {
      flush: () => saveGuion(),
      destroy: () => {
        closed = true;
        clearTimeout(guionTimer);
        removers.forEach((fn) => fn());
      },
    };
  }

  // Abrir un contenido desde el link (?item=<id>).
  const initial = ctx.params.get('item');
  if (initial) openItem(initial);

  return () => {
    cleanups.forEach((fn) => fn());
    panel?.close();
  };
}
