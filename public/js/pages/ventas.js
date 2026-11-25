// Ventas: CRM de agendas (Kanban / Lista / Calendario), igual a /crm de la versión completa.
// Panel de la agenda con campos editables, estatus tipo noCRM, notas y el
// resultado de la llamada (una «venta» crea el cliente y su pago inicial).
import { del, get, patch, post, put } from '../core/api.js';
import { addDays, todayStr, weekStart } from '../core/dates.js';
import { colorOf, digits, esc, firstName, fmtDate, fmtDateTime, fromLocalInput, h, icons, initialsOf, money, norm, toLocalInput } from '../core/dom.js';
import { burst } from '../core/fx.js';
import { enableDrag, isDragging } from '../core/dnd.js';
import { attempt, confirmDialog, createButton, expandableSearch, sidePanel, toast, userOptions, viewToggle } from '../core/ui.js';

const STATUS_LABELS = { para_hoy: '¡Para hoy!', standby: 'Standby', ganado: 'Ganado', perdido: 'Perdido', cancelado: 'Cancelado' };
const STATUS_ICON = { para_hoy: '🔥', standby: '⏸️', ganado: '🏆', perdido: '🚫', cancelado: '✖️' };
const TIPO_LABELS = { entrada: 'Entrada', ganado: 'Ganado', perdido: 'Perdido', reagendar: 'Reagendar' };
const RESULTADO_LABELS = {
  venta: 'Venta',
  reserva: 'Reserva',
  no_show: 'No show',
  no_cerro: 'No cerró',
  pidio_reagendar: 'Pidió reagendar (aún sin fecha nueva)',
  cancelada: 'Cancelada (no califica)',
};
const METODOS = ['Transferencia', 'Mercado Pago', 'PayPal', 'Dlocal Go', 'Tarjeta', 'Efectivo', 'Otro'];
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// ---------------------------------------------------------------- badge de tiempo (como noCRM)
function fmtDur(ms) {
  const abs = Math.abs(ms);
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  if (abs >= DAY) return `${Math.round(abs / DAY)}d`;
  if (abs >= HOUR) return `${Math.round(abs / HOUR)}h`;
  return `${Math.max(1, Math.round(abs / 60_000))}m`;
}
function timeBadge(v) {
  if (['ganado', 'perdido', 'cancelado'].includes(v.status) || !v.proxima_accion) return null;
  const diff = new Date(v.proxima_accion).getTime() - Date.now();
  return diff > 0 ? { text: `en ${fmtDur(diff)}`, overdue: false } : { text: `${fmtDur(diff)} retraso`, overdue: true };
}
function badgeHtml(v, extraClass = '') {
  const b = timeBadge(v);
  const closed = ['ganado', 'perdido', 'cancelado'].includes(v.status);
  const label = closed ? STATUS_LABELS[v.status] : b ? (b.overdue ? `⚠️ ${b.text}` : `🔔 ${b.text}`) : '—';
  return `<button type="button" class="status-time-badge status-time-badge-${esc(v.status)}${b?.overdue ? ' overdue' : ''} ${extraClass}" data-status="${esc(v.id)}">${esc(label)}</button>`;
}

export async function render(root, ctx) {
  const { user } = ctx;
  const isAdmin = ctx.isAdmin;
  const st = {
    etapas: [],
    ventas: [],
    usuarios: [],
    view: ['kanban', 'lista', 'calendario'].includes(ctx.params.get('vista')) ? ctx.params.get('vista') : 'kanban',
    search: '',
    closer: null,
    setter: null,
    presupuesto: null,
    calMode: 'mes',
    calCursor: todayStr(),
    panel: null,
  };
  const usersById = () => new Map(st.usuarios.map((u) => [u.id, u]));
  const canEdit = (v) => isAdmin || (!v.setter_id && !v.closer_id) || v.setter_id === user.id || v.closer_id === user.id;

  root.innerHTML = `<div class="crm-page"><div class="lite-loading"><span class="lite-spinner"></span>Cargando agendas…</div></div>`;
  const page = root.firstElementChild;

  async function load() {
    const d = await get('/ventas');
    st.etapas = d.etapas;
    st.ventas = d.ventas;
    st.usuarios = d.usuarios;
  }
  try {
    await load();
  } catch (err) {
    page.innerHTML = `<div class="lite-empty">${esc(err.message)}</div>`;
    return;
  }

  // ---------------------------------------------------------------- filtros
  function visible() {
    const q = norm(st.search.trim());
    const qd = digits(st.search);
    return st.ventas.filter((v) => {
      if (st.closer && (st.closer === 'none' ? v.closer_id : v.closer_id !== st.closer)) return false;
      if (st.setter && (st.setter === 'none' ? v.setter_id : v.setter_id !== st.setter)) return false;
      if (st.presupuesto && (st.presupuesto === 'nd' ? v.presupuesto : v.presupuesto !== st.presupuesto)) return false;
      if (!q) return true;
      return (
        norm(v.nombre).includes(q) ||
        norm(v.email).includes(q) ||
        norm(v.instagram).includes(q) ||
        norm(v.contact_id).includes(q) ||
        (qd.length >= 3 && digits(v.telefono).includes(qd))
      );
    });
  }

  function overdueList() {
    const now = Date.now();
    return st.ventas.filter(
      (v) => v.fecha_llamada && new Date(v.fecha_llamada).getTime() < now && !v.resultado && !['cancelado', 'perdido', 'ganado'].includes(v.status),
    );
  }

  // ---------------------------------------------------------------- dibujo
  function chips(label, key, options) {
    if (options.length === 0) return '';
    return `
      <div class="crm-filter-row" data-filter="${key}">
        <span class="crm-filter-label">${esc(label)}</span>
        <button type="button" class="crm-chip${st[key] === null ? ' active' : ''}" data-val="">Todos</button>
        ${options
          .map(
            (o) =>
              `<button type="button" class="crm-chip${st[key] === o.key ? ' active' : ''}" data-val="${esc(o.key)}">${
                o.color ? `<span class="crm-chip-avatar" style="background:${o.color}">${esc(o.initials)}</span>` : ''
              }${esc(o.label)} <span class="lite-chip-count">${o.count}</span></button>`,
          )
          .join('')}
      </div>`;
  }

  function personOptions(field, role) {
    const counts = new Map();
    for (const v of st.ventas) counts.set(v[field] || 'none', (counts.get(v[field] || 'none') || 0) + 1);
    const people = st.usuarios.filter((u) => u.roles.includes(role) || counts.has(u.id));
    const opts = people
      .filter((u) => counts.has(u.id) || u.roles.includes(role))
      .map((u) => ({ key: u.id, label: firstName(u), color: colorOf(u.id), initials: initialsOf(u.email), count: counts.get(u.id) || 0 }));
    if (counts.has('none')) opts.push({ key: 'none', label: 'Sin asignar', count: counts.get('none') });
    return opts;
  }

  function draw() {
    const list = visible();
    const overdue = overdueList();
    page.innerHTML = `
      <div class="crm-toolbar">
        <div>
          <span class="crm-eyebrow">Ventas</span>
          <h1>Funnel</h1>
        </div>
        <div class="crm-toolbar-actions">
          <span class="lite-search-slot"></span>
          ${overdue.length ? `<button type="button" class="crm-chip crm-overdue-btn" data-overdue>⚠ ${overdue.length} atrasada${overdue.length === 1 ? '' : 's'} sin resultado</button>` : ''}
          ${viewToggle(
            [
              { key: 'kanban', label: 'Kanban' },
              { key: 'lista', label: 'Lista' },
              { key: 'calendario', label: 'Calendario' },
            ],
            st.view,
          )}
          ${createButton('Crear', 'data-create')}
        </div>
      </div>
      ${chips('Closer', 'closer', personOptions('closer_id', 'closer'))}
      ${chips('Setter', 'setter', personOptions('setter_id', 'setter'))}
      ${chips('Presupuesto', 'presupuesto', [
        { key: 'con', label: 'Con presupuesto', count: st.ventas.filter((v) => v.presupuesto === 'con').length },
        { key: 'sin', label: 'Sin presupuesto', count: st.ventas.filter((v) => v.presupuesto === 'sin').length },
        { key: 'nd', label: 'Sin dato', count: st.ventas.filter((v) => !v.presupuesto).length },
      ])}
      <div class="lite-view"></div>`;
    page.querySelector('.lite-search-slot').replaceWith(
      expandableSearch({
        placeholder: 'Buscar nombre, teléfono, email, Instagram, contact ID…',
        value: st.search,
        onInput: (v) => {
          st.search = v;
          drawView();
        },
      }),
    );
    drawView(list);
  }

  function drawView(list = visible()) {
    const box = page.querySelector('.lite-view');
    if (!box) return;
    if (st.view === 'kanban') box.innerHTML = boardHtml(list);
    else if (st.view === 'lista') box.innerHTML = listHtml(list);
    else box.innerHTML = calendarHtml(list);
  }

  function cardHtml(v, byId) {
    const closer = v.closer_id ? byId.get(v.closer_id) : null;
    const setter = v.setter_id ? byId.get(v.setter_id) : null;
    const mine = v.setter_id === user.id || v.closer_id === user.id;
    const editable = canEdit(v);
    return `
      <div class="crm-card${mine ? ' crm-card-mine' : ''}${editable ? ' lite-draggable' : ''}" data-card="${esc(v.id)}">
        <div class="crm-card-top">
          ${
            closer
              ? `<span class="crm-card-avatar" style="background:${colorOf(closer.id)}" title="Closer: ${esc(closer.nombre)}">${esc(initialsOf(closer.email))}</span>`
              : '<span class="crm-card-avatar crm-card-avatar-empty" title="Sin closer">?</span>'
          }
          <span class="crm-card-name">${esc(v.nombre)}</span>
        </div>
        <div class="crm-card-bottom">
          ${
            setter
              ? `<span class="crm-card-tag crm-card-tag-setter" title="Setter: ${esc(setter.nombre)}"><span class="crm-card-tag-dot" style="background:${colorOf(setter.id)}"></span>${esc(firstName(setter))}</span>`
              : '<span class="crm-card-tag" title="Llegó sin setter">Sin setter</span>'
          }
          ${badgeHtml(v)}
        </div>
      </div>`;
  }

  function boardHtml(list) {
    const byId = usersById();
    const byStage = new Map(st.etapas.map((e) => [e.id, []]));
    const orphan = [];
    for (const v of list) (byStage.get(v.etapa_id) || orphan).push(v);
    for (const arr of byStage.values()) arr.sort((a, b) => a.orden - b.orden || a.creado.localeCompare(b.creado));
    return `
      <div class="crm-board">
        ${st.etapas
          .map(
            (e) => `
          <div class="crm-column" data-stage="${esc(e.id)}">
            <div class="crm-column-header">
              <span class="crm-column-title">${esc(e.nombre)}${e.tipo ? `<span class="crm-column-entry-badge">${esc(TIPO_LABELS[e.tipo] || e.tipo)}</span>` : ''}</span>
              <span class="crm-column-count">${byStage.get(e.id).length}</span>
              ${
                isAdmin
                  ? `<div class="decision-menu-wrapper"><button type="button" class="decision-menu-btn" title="Opciones" data-stage-menu="${esc(e.id)}">⋮</button></div>`
                  : ''
              }
            </div>
            <div class="crm-column-body">${byStage.get(e.id).map((v) => cardHtml(v, byId)).join('')}</div>
          </div>`,
          )
          .join('')}
        ${isAdmin ? `<div class="crm-column crm-add-column"><button type="button" class="crm-add-column-btn btn-secondary" data-add-stage>${icons.plus} Agregar columna</button></div>` : ''}
      </div>
      ${orphan.length ? `<p class="lite-hint">${orphan.length} agenda(s) sin columna: ábrelas desde la Lista.</p>` : ''}`;
  }

  function personCell(u) {
    return u
      ? `<span class="clients-table-coach"><span class="crm-chip-avatar" style="background:${colorOf(u.id)}">${esc(initialsOf(u.email))}</span>${esc(firstName(u))}</span>`
      : '<span class="crm-card-tag-empty">Sin asignar</span>';
  }

  function listHtml(list) {
    const byId = usersById();
    const stages = new Map(st.etapas.map((e) => [e.id, e]));
    const sorted = [...list].sort((a, b) => b.agendada.localeCompare(a.agendada));
    return `
      <div class="clients-table-wrap">
        <table class="clients-table">
          <thead><tr><th>Lead</th><th>Etapa</th><th>Estatus</th><th>Llamada</th><th>Setter</th><th>Closer</th><th>Resultado</th><th>Agendó</th></tr></thead>
          <tbody>
            ${sorted
              .map((v) => {
                const stg = stages.get(v.etapa_id);
                return `<tr data-card="${esc(v.id)}">
                  <td class="clients-table-name">${esc(v.nombre)}</td>
                  <td>${stg ? `<span class="clients-status">${esc(stg.nombre)}</span>` : '—'}</td>
                  <td>${badgeHtml(v)}</td>
                  <td>${v.fecha_llamada ? esc(fmtDateTime(v.fecha_llamada)) : '—'}</td>
                  <td>${personCell(byId.get(v.setter_id))}</td>
                  <td>${personCell(byId.get(v.closer_id))}</td>
                  <td>${v.resultado ? esc(RESULTADO_LABELS[v.resultado]?.split(' (')[0] || v.resultado) : '—'}</td>
                  <td>${esc(fmtDate(v.agendada, { year: false }))}</td>
                </tr>`;
              })
              .join('')}
            ${sorted.length === 0 ? '<tr><td colspan="8" class="clients-table-empty">No hay agendas con estos filtros. Crea una con el botón «Crear».</td></tr>' : ''}
          </tbody>
        </table>
      </div>`;
  }

  function calendarHtml(list) {
    const byId = usersById();
    const byDay = new Map();
    for (const v of list) {
      if (!v.fecha_llamada || v.status === 'cancelado') continue;
      const d = todayStr(new Date(v.fecha_llamada));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(v);
    }
    for (const arr of byDay.values()) arr.sort((a, b) => a.fecha_llamada.localeCompare(b.fecha_llamada));
    const today = todayStr();
    const chip = (v) => {
      const closer = byId.get(v.closer_id);
      const t = new Date(v.fecha_llamada).toLocaleTimeString('es-PE', { hour: 'numeric', minute: '2-digit' });
      return `<button type="button" class="content-calendar-chip crm-calendar-chip" data-card="${esc(v.id)}">
        ${closer ? `<span class="crm-chip-avatar crm-calendar-chip-avatar" style="background:${colorOf(closer.id)}">${esc(initialsOf(closer.email))}</span>` : ''}
        <span class="crm-calendar-chip-time">${esc(t)}</span><span class="content-calendar-chip-text">${esc(v.nombre)}</span></button>`;
    };
    const cell = (ds, { outside = false, tall = false, label = '' } = {}) => `
      <div class="content-calendar-cell${ds === today ? ' today' : ''}${outside ? ' outside' : ''}${tall ? ' tall' : ''}">
        ${label || `<span class="content-calendar-daynum">${Number(ds.slice(8))}</span>`}
        <div class="content-calendar-items">${(byDay.get(ds) || []).map(chip).join('')}</div>
      </div>`;
    const [y, m] = st.calCursor.split('-').map(Number);
    let body;
    let title;
    if (st.calMode === 'mes') {
      title = `${MONTHS[m - 1]} ${y}`;
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      const start = weekStart(first);
      const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const end = addDays(weekStart(lastDay), 6);
      const days = [];
      for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
      body = `
        <div class="content-calendar-grid content-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="content-calendar-grid content-calendar-days">${days.map((d) => cell(d, { outside: d.slice(5, 7) !== String(m).padStart(2, '0') })).join('')}</div>`;
    } else {
      const start = weekStart(st.calCursor);
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      title = `${fmtDate(days[0], { year: false })} – ${fmtDate(days[6])}`;
      body = `<div class="content-calendar-week">${days
        .map(
          (d, i) => `<div class="content-calendar-week-col"><span class="content-calendar-week-daylabel">${WEEKDAYS[i]} ${Number(d.slice(8))}</span>${cell(d, { tall: true, label: ' ' })}</div>`,
        )
        .join('')}</div>`;
    }
    return `
      <div class="lite-cal-head"><div class="content-calendar-subview-toggle">
        <button type="button" class="${st.calMode === 'semana' ? 'active' : ''}" data-cal-mode="semana">Semana</button>
        <button type="button" class="${st.calMode === 'mes' ? 'active' : ''}" data-cal-mode="mes">Mes</button>
      </div></div>
      <div class="content-calendar">
        <div class="content-calendar-nav">
          <button type="button" data-cal-step="-1" aria-label="Anterior">‹</button>
          <span class="content-calendar-month">${esc(title)}</span>
          <button type="button" data-cal-step="1" aria-label="Siguiente">›</button>
          <button type="button" class="content-calendar-today" data-cal-today>Hoy</button>
        </div>
        ${body}
      </div>`;
  }

  // ---------------------------------------------------------------- acciones del tablero
  function upsertLocal(v) {
    const i = st.ventas.findIndex((x) => x.id === v.id);
    if (i >= 0) st.ventas[i] = { ...st.ventas[i], ...v };
    else st.ventas.push(v);
  }

  async function moveCard(id, etapaId, beforeId) {
    const v = st.ventas.find((x) => x.id === id);
    if (!v) return;
    const prev = { etapa_id: v.etapa_id, orden: v.orden, status: v.status };
    // Optimista: se ve al toque; si falla, vuelve.
    const col = st.ventas.filter((x) => x.etapa_id === etapaId && x.id !== id).sort((a, b) => a.orden - b.orden);
    const idx = beforeId ? col.findIndex((x) => x.id === beforeId) : col.length;
    const before = col[idx];
    const after = col[idx - 1];
    v.etapa_id = etapaId;
    v.orden = before ? (after ? (after.orden + before.orden) / 2 : before.orden - 1) : (col.at(-1)?.orden ?? 0) + 1;
    drawView();
    try {
      const r = await post(`/ventas/${id}/mover`, { etapaId, beforeId: beforeId || null });
      upsertLocal(r.venta);
      drawView();
    } catch (err) {
      Object.assign(v, prev);
      drawView();
      toast(err.message, { error: true });
      if (err.status === 409) openCard(id, { notice: err.message });
    }
  }

  // Arrastrar y soltar con puntero (mouse y dedo), como dnd-kit en la versión completa.
  const stopDrag = enableDrag(page, {
    item: '.crm-card[data-card]',
    zone: '.crm-column[data-stage]',
    list: (col) => col.querySelector('.crm-column-body'),
    canDrag: (el) => {
      const v = st.ventas.find((x) => x.id === el.dataset.card);
      return !!v && canEdit(v) && st.view === 'kanban';
    },
    overlayClass: 'crm-card-overlay',
    onDrop: ({ item, zone, before }) => moveCard(item.dataset.card, zone.dataset.stage, before?.dataset.card || null),
  });

  page.addEventListener('click', async (e) => {
    const t = e.target;
    const statusBtn = t.closest('[data-status]');
    if (statusBtn) {
      e.stopPropagation();
      const v = st.ventas.find((x) => x.id === statusBtn.dataset.status);
      if (v && canEdit(v)) openStatus(v);
      else if (v) openCard(v.id);
      return;
    }
    const chip = t.closest('.crm-filter-row[data-filter] [data-val]');
    if (chip) {
      const key = chip.closest('[data-filter]').dataset.filter;
      st[key] = chip.dataset.val || null;
      draw();
      return;
    }
    const view = t.closest('[data-view]');
    if (view) {
      st.view = view.dataset.view;
      ctx.setParams({ vista: st.view === 'kanban' ? null : st.view });
      page.querySelectorAll('.crm-view-toggle button').forEach((b) => b.classList.toggle('active', b === view));
      drawView();
      return;
    }
    if (t.closest('[data-create]')) return openCreate();
    if (t.closest('[data-overdue]')) return openOverdue();
    if (t.closest('[data-add-stage]')) return addStage();
    const menu = t.closest('[data-stage-menu]');
    if (menu) return openStageMenu(menu);
    const calMode = t.closest('[data-cal-mode]');
    if (calMode) {
      st.calMode = calMode.dataset.calMode;
      drawView();
      return;
    }
    const step = t.closest('[data-cal-step]');
    if (step) {
      const n = Number(step.dataset.calStep);
      if (st.calMode === 'mes') {
        const [y, m] = st.calCursor.split('-').map(Number);
        st.calCursor = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
      } else st.calCursor = addDays(st.calCursor, 7 * n);
      drawView();
      return;
    }
    if (t.closest('[data-cal-today]')) {
      st.calCursor = todayStr();
      drawView();
      return;
    }
    const card = t.closest('[data-card]');
    if (card) openCard(card.dataset.card);
  });

  // ---------------------------------------------------------------- columnas (admin)
  function openStageMenu(btn) {
    page.querySelectorAll('.decision-menu').forEach((m) => m.remove());
    const e = st.etapas.find((x) => x.id === btn.dataset.stageMenu);
    if (!e) return;
    const menu = h(`
      <div class="decision-menu">
        <button type="button" data-act="rename">✏️ Renombrar</button>
        ${e.tipo !== 'entrada' ? '<button type="button" data-act="entrada">⭐ Marcar como entrada</button>' : ''}
        ${e.tipo !== 'ganado' ? '<button type="button" data-act="ganado">🏆 Marcar como Ganado</button>' : ''}
        ${e.tipo !== 'perdido' ? '<button type="button" data-act="perdido">🚫 Marcar como Perdido</button>' : ''}
        ${e.tipo !== 'reagendar' ? '<button type="button" data-act="reagendar">🔁 Marcar como Reagendar</button>' : ''}
        <button type="button" data-act="left">← Mover a la izquierda</button>
        <button type="button" data-act="right">→ Mover a la derecha</button>
        <button type="button" class="danger" data-act="delete">🗑️ Eliminar columna</button>
      </div>`);
    btn.parentElement.appendChild(menu);
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close));
    menu.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      menu.remove();
      document.removeEventListener('mousedown', close);
      if (act === 'rename') {
        const title = btn.closest('.crm-column-header').querySelector('.crm-column-title');
        const input = h(`<input class="crm-column-title-input" value="${esc(e.nombre)}">`);
        title.replaceWith(input);
        input.focus();
        input.select();
        const commit = async () => {
          const nombre = input.value.trim();
          if (nombre && nombre !== e.nombre) {
            const r = await attempt(() => patch(`/etapas/${e.id}`, { nombre }));
            if (r) st.etapas = r.etapas;
          }
          drawView();
        };
        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (k) => k.key === 'Enter' && input.blur());
      } else if (['entrada', 'ganado', 'perdido', 'reagendar'].includes(act)) {
        const r = await attempt(() => patch(`/etapas/${e.id}`, { tipo: act }));
        if (r) {
          st.etapas = r.etapas;
          drawView();
        }
      } else if (act === 'left' || act === 'right') {
        const i = st.etapas.findIndex((x) => x.id === e.id);
        const j = act === 'left' ? i - 1 : i + 1;
        if (j < 0 || j >= st.etapas.length) return;
        [st.etapas[i], st.etapas[j]] = [st.etapas[j], st.etapas[i]];
        drawView();
        await attempt(() => put('/etapas/orden', { ids: st.etapas.map((x) => x.id) }));
      } else if (act === 'delete') {
        if (!(await confirmDialog(`¿Eliminar la columna «${e.nombre}»?`, { ok: 'Eliminar', danger: true }))) return;
        const r = await attempt(() => del(`/etapas/${e.id}`));
        if (r) {
          st.etapas = st.etapas.filter((x) => x.id !== e.id);
          drawView();
        }
      }
    });
  }

  async function addStage() {
    const btn = page.querySelector('[data-add-stage]');
    const form = h(`<form class="crm-add-column-form lite-form"><input class="lite-input" placeholder="Nombre de la columna" required><div class="lite-actions"><button type="submit" class="crm-create-btn btn-sm">Agregar</button><button type="button" class="btn-ghost" data-cancel>Cancelar</button></div></form>`);
    btn.replaceWith(form);
    const input = form.querySelector('input');
    input.focus();
    form.querySelector('[data-cancel]').onclick = () => drawView();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const r = await attempt(() => post('/etapas', { nombre: input.value }));
      if (r) st.etapas.push(r.etapa);
      drawView();
    });
  }

  // ---------------------------------------------------------------- estatus (modal tipo noCRM)
  function openStatus(v) {
    const presets = [
      { label: 'En 1 hora', hours: 1 },
      { label: 'En 3 horas', hours: 3 },
      { label: 'Mañana', hours: 24 },
      { label: 'En 3 días', hours: 72 },
      { label: 'En 1 semana', hours: 168 },
    ];
    const el = h(`
      <div class="status-modal-overlay">
        <div class="status-modal">
          <p class="status-modal-title">Elegir un estatus:</p>
          <div class="status-modal-options">
            ${Object.keys(STATUS_LABELS)
              .map((s) => `<button type="button" class="status-pill status-pill-${s}${v.status === s ? ' active' : ''}" data-pick="${s}">${STATUS_ICON[s]} ${STATUS_LABELS[s]}</button>`)
              .join('')}
          </div>
          <div class="lite-status-reminder">
            <p class="status-modal-question">¿Terminaste de gestionar este lead?</p>
            <button type="button" class="status-modal-secondary" data-reminder>Pon un recordatorio para la próxima acción</button>
          </div>
          <button type="button" class="status-modal-close" data-close>Cerrar</button>
        </div>
      </div>`);
    const close = () => el.remove();
    el.addEventListener('click', async (ev) => {
      if (ev.target === el || ev.target.closest('[data-close]')) return close();
      const pick = ev.target.closest('[data-pick]');
      if (pick) {
        if (pick.dataset.pick === 'standby') return showReminder();
        return save(pick.dataset.pick);
      }
      if (ev.target.closest('[data-reminder]')) return showReminder();
      const pre = ev.target.closest('[data-hours]');
      if (pre) return save('standby', new Date(Date.now() + Number(pre.dataset.hours) * 3_600_000).toISOString());
    });
    function showReminder() {
      el.querySelector('.lite-status-reminder').innerHTML = `
        <div class="status-modal-reminder">
          <p class="status-modal-question">¿Para cuándo el próximo paso?</p>
          <div class="status-modal-presets">${presets.map((p) => `<button type="button" data-hours="${p.hours}">${p.label}</button>`).join('')}</div>
          <form><input type="datetime-local" required><button type="submit">Guardar recordatorio</button></form>
        </div>`;
      el.querySelector('form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const val = el.querySelector('input').value;
        if (val) save('standby', fromLocalInput(val));
      });
    }
    async function save(status, proximaAccion) {
      const r = await attempt(() => post(`/ventas/${v.id}/estatus`, { status, proximaAccion }));
      if (!r) return;
      upsertLocal(r.venta);
      close();
      drawView();
      if (st.panel?.id === v.id) openCard(v.id);
    }
    document.body.appendChild(el);
  }

  // ---------------------------------------------------------------- crear
  function openCreate() {
    const p = sidePanel('Nueva agenda');
    const isCloser = user.roles.includes('closer');
    const isSetter = user.roles.includes('setter');
    p.body.innerHTML = `
      <form class="crm-create-form" novalidate>
        <label>Nombre<input name="nombre" required autocomplete="off"></label>
        <label>Teléfono<input name="telefono" autocomplete="off"></label>
        <label>Email<input name="email" type="email" autocomplete="off"></label>
        <label>Instagram<input name="instagram" autocomplete="off" placeholder="usuario"></label>
        <label>Contact ID (ManyChat)<input name="contact_id" autocomplete="off"></label>
        <label>Fecha de la llamada<input name="fecha_llamada" type="datetime-local"></label>
        <label>Setter<select name="setter_id">${userOptions(st.usuarios, isSetter && !isAdmin ? user.id : '', { roles: ['setter'] })}</select></label>
        <label>Closer<select name="closer_id">${userOptions(st.usuarios, isCloser && !isAdmin ? user.id : '', { roles: ['closer'] })}</select></label>
        <label>Presupuesto<select name="presupuesto"><option value="">Sin dato</option><option value="con">Con presupuesto</option><option value="sin">Sin presupuesto</option></select></label>
        <label>Columna<select name="etapa_id">${st.etapas.map((e) => `<option value="${esc(e.id)}" ${e.tipo === 'entrada' ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select></label>
        ${isAdmin ? '<label>Cuándo llegó la agenda (si es un lead viejo)<input name="agendada" type="datetime-local"></label><span class="crm-field-hint">Vacío = ahora.</span>' : ''}
        <p class="lite-error" role="alert"></p>
        <button type="submit">Crear agenda</button>
      </form>`;
    const form = p.body.querySelector('form');
    form.querySelector('input').focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (!data.nombre.trim()) return (form.querySelector('.lite-error').textContent = 'Falta el nombre');
      data.fecha_llamada = fromLocalInput(data.fecha_llamada);
      if (data.agendada) data.agendada = fromLocalInput(data.agendada);
      else delete data.agendada;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await post('/ventas', data);
        upsertLocal(r.venta);
        p.close();
        drawView();
        toast('Agenda creada');
      } catch (err) {
        form.querySelector('.lite-error').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- llamadas atrasadas
  function openOverdue() {
    const p = sidePanel('Llamadas atrasadas sin resultado');
    const list = overdueList().sort((a, b) => a.fecha_llamada.localeCompare(b.fecha_llamada));
    const byId = usersById();
    p.body.innerHTML = `
      <p class="crm-panel-notice">La llamada ya pasó y nadie cargó qué pasó. Mientras no tengan resultado bajan el show rate: carga No show, No cerró, Venta… en cada una.</p>
      ${list
        .map(
          (v) => `<button type="button" class="lite-overdue-row" data-open="${esc(v.id)}">
            <strong>${esc(v.nombre)}</strong>
            <span>${esc(fmtDateTime(v.fecha_llamada))} · ${esc(byId.get(v.closer_id)?.nombre || 'sin closer')}</span>
          </button>`,
        )
        .join('')}`;
    p.body.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-open]');
      if (b) {
        p.close();
        openCard(b.dataset.open, { focusOutcome: true });
      }
    });
  }

  // ---------------------------------------------------------------- panel de la agenda
  async function openCard(id, { notice = '', focusOutcome = false } = {}) {
    const base = st.ventas.find((x) => x.id === id);
    if (!base) return;
    st.panel?.close?.();
    const p = sidePanel(base.nombre, { onClose: () => (st.panel = null) });
    st.panel = { id, close: p.close };
    p.body.innerHTML = '<div class="lite-loading"><span class="lite-spinner"></span>Cargando…</div>';
    let d;
    try {
      d = await get(`/ventas/${id}`);
    } catch (err) {
      p.body.innerHTML = `<div class="lite-empty">${esc(err.message)}</div>`;
      return;
    }
    const v = d.venta;
    upsertLocal(v);
    const editable = canEdit(v);
    const byId = usersById();
    const owner = [v.setter_id && `setter ${byId.get(v.setter_id)?.nombre || ''}`, v.closer_id && `closer ${byId.get(v.closer_id)?.nombre || ''}`]
      .filter(Boolean)
      .join(' · ');
    const field = (key, label, value, { type = 'text', cls = '' } = {}) => `
      <div class="crm-field ${cls}" data-field="${key}" data-type="${type}">
        <span class="crm-field-label">${esc(label)}</span>
        <span class="${editable ? 'editable ' : ''}crm-field-value" data-raw="${esc(value)}">${esc(type === 'datetime-local' ? (value ? fmtDateTime(value) : '') : value) || '—'}</span>
      </div>`;
    p.body.innerHTML = `
      ${!editable ? `<p class="crm-panel-notice crm-panel-readonly">Solo lectura${owner ? `: es de ${esc(owner)}` : ''}. Puedes ver todo, pero solo quien la tiene asignada puede cambiarla.</p>` : ''}
      ${notice ? `<p class="crm-panel-notice">${esc(notice)}</p>` : ''}
      ${(() => {
        const b = timeBadge(v);
        return `<button type="button" class="status-time-badge status-time-badge-${esc(v.status)}${b?.overdue ? ' overdue' : ''} status-detail-badge">${esc(STATUS_LABELS[v.status] || v.status)}${
          b ? `<span> · ${esc(b.overdue ? `⚠️ ${b.text}` : `🔔 ${b.text}`)}</span>` : ''
        }</button>`;
      })()}
      ${field('contact_id', 'Contact ID (ManyChat)', v.contact_id, { cls: 'crm-field-contact-id' })}
      ${field('nombre', 'Nombre', v.nombre)}
      ${field('telefono', 'Teléfono', v.telefono)}
      ${v.telefono ? `<a class="lite-wa-link" href="https://wa.me/${digits(v.telefono)}" target="_blank" rel="noopener">Abrir WhatsApp</a>` : ''}
      ${field('email', 'Email', v.email, { type: 'email' })}
      ${field('instagram', 'Instagram', v.instagram)}
      ${field('fecha_llamada', 'Fecha de la llamada', v.fecha_llamada, { type: 'datetime-local' })}
      ${isAdmin ? field('agendada', 'Cuándo llegó la agenda (no es la fecha de la llamada)', v.agendada, { type: 'datetime-local' }) : ''}
      <div class="crm-field"><span class="crm-field-label">Setter</span><select data-select="setter_id" ${editable ? '' : 'disabled'}>${userOptions(st.usuarios, v.setter_id, { roles: ['setter'] })}</select></div>
      <div class="crm-field"><span class="crm-field-label">Closer</span><select data-select="closer_id" ${editable ? '' : 'disabled'}>${userOptions(st.usuarios, v.closer_id, { roles: ['closer'] })}</select></div>
      <div class="crm-field"><span class="crm-field-label">Presupuesto</span><select data-select="presupuesto" ${editable ? '' : 'disabled'}>
        <option value="" ${!v.presupuesto ? 'selected' : ''}>Sin dato</option>
        <option value="con" ${v.presupuesto === 'con' ? 'selected' : ''}>Con presupuesto</option>
        <option value="sin" ${v.presupuesto === 'sin' ? 'selected' : ''}>Sin presupuesto</option>
      </select></div>
      <div class="lite-outcome-slot"></div>
      ${d.cliente ? `<p class="crm-panel-notice">Ya es cliente: <a href="/clientes?cliente=${esc(d.cliente.id)}" data-link>ver en Clientes →</a></p>` : ''}
      <div class="crm-tabs"><button type="button" class="active">Notas</button></div>
      <div class="crm-notes">
        <div class="lite-notes-list">${notesHtml(d.notas)}</div>
        <form class="crm-add-note-form"><textarea rows="3" placeholder="Escribe una nota…"></textarea><button type="submit" class="crm-create-btn btn-sm">Agregar nota</button></form>
      </div>
      ${isAdmin ? '<button type="button" class="crm-delete-btn" data-delete>Eliminar agenda</button>' : ''}`;

    // Campos que se editan al tocarlos (como EditableField de la versión completa).
    p.body.addEventListener('click', (ev) => {
      const val = ev.target.closest('.crm-field-value.editable');
      if (!val || !editable) return;
      const f = val.closest('[data-field]');
      const type = f.dataset.type;
      const raw = val.dataset.raw;
      const input = h(`<input type="${type}" value="${esc(type === 'datetime-local' ? toLocalInput(raw) : raw)}">`);
      val.replaceWith(input);
      input.focus();
      const commit = async () => {
        let nv = input.value.trim();
        if (type === 'datetime-local') nv = nv ? fromLocalInput(nv) : '';
        if (nv === raw || (type === 'datetime-local' && raw && nv && new Date(nv).getTime() === new Date(raw).getTime())) return openCard(id);
        const r = await attempt(() => patch(`/ventas/${id}`, { [f.dataset.field]: nv }));
        if (r) {
          upsertLocal(r.venta);
          drawView();
          if (f.dataset.field === 'nombre') p.setTitle(r.venta.nombre);
        }
        openCard(id);
      };
      input.addEventListener('blur', commit, { once: true });
      input.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') input.blur();
        if (k.key === 'Escape') {
          k.stopPropagation();
          openCard(id);
        }
      });
    });
    p.body.addEventListener('change', async (ev) => {
      const sel = ev.target.closest('[data-select]');
      if (!sel) return;
      const r = await attempt(() => patch(`/ventas/${id}`, { [sel.dataset.select]: sel.value }));
      if (r) {
        upsertLocal(r.venta);
        drawView();
        toast('Guardado ✓');
      }
    });
    p.body.querySelector('.status-detail-badge')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (editable) openStatus(st.ventas.find((x) => x.id === id));
    });
    const noteForm = p.body.querySelector('.crm-add-note-form');
    noteForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ta = noteForm.querySelector('textarea');
      if (!ta.value.trim()) return;
      const r = await attempt(() => post(`/ventas/${id}/notas`, { texto: ta.value }));
      if (r) {
        d.notas.unshift(r.nota);
        p.body.querySelector('.lite-notes-list').innerHTML = notesHtml(d.notas);
        ta.value = '';
      }
    });
    p.body.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(`¿Eliminar la agenda de ${v.nombre}? No se puede deshacer.`, { ok: 'Eliminar', danger: true }))) return;
      const r = await attempt(() => del(`/ventas/${id}`));
      if (r) {
        st.ventas = st.ventas.filter((x) => x.id !== id);
        p.close();
        drawView();
        toast('Agenda eliminada');
      }
    });
    renderOutcome(p.body.querySelector('.lite-outcome-slot'), v, d.resultado, editable, () => openCard(id));
    if (focusOutcome) p.body.querySelector('.lite-outcome-slot')?.scrollIntoView({ block: 'center' });
  }

  function notesHtml(notas) {
    if (!notas.length) return '<p class="crm-notes-empty">Sin notas todavía.</p>';
    return notas
      .map(
        (n) => `<div class="crm-note"><div class="crm-note-meta"><span>${esc(n.autor || '')}</span><span>${esc(fmtDateTime(n.creado))}</span></div><p>${esc(n.texto)}</p></div>`,
      )
      .join('');
  }

  // ---------------------------------------------------------------- resultado de la llamada
  function renderOutcome(slot, v, r, editable, reopen) {
    const canSaveAny = isAdmin || user.roles.includes('closer');
    const canCancel = canSaveAny || user.roles.includes('setter');
    if (!editable || !canCancel) {
      slot.innerHTML = r
        ? `<div class="crm-outcome crm-outcome-readonly"><span class="crm-field-label">Resultado de la llamada</span><p>${esc(RESULTADO_LABELS[r.resultado] || r.resultado)}${
            r.resultado === 'venta' && r.programa ? ` — ${esc(r.programa)} (${esc(money(r.monto_total))})` : ''
          }${r.motivo ? ` — ${esc(r.motivo)}` : ''}</p></div>`
        : '';
      return;
    }
    const allowed = canSaveAny ? Object.keys(RESULTADO_LABELS) : ['pidio_reagendar', 'cancelada'];
    const programas = [...new Set(st.ventas.map((x) => x.resultado_programa).filter(Boolean))];
    slot.innerHTML = `
      <form class="crm-outcome" novalidate>
        <span class="crm-field-label">Resultado de la llamada</span>
        <select name="resultado">
          <option value="">Seleccionar...</option>
          ${allowed.map((k) => `<option value="${k}" ${r?.resultado === k ? 'selected' : ''}>${esc(RESULTADO_LABELS[k])}</option>`).join('')}
        </select>
        <div class="lite-outcome-fields"></div>
        <p class="lite-error" role="alert"></p>
        <button type="submit" class="crm-outcome-save">Guardar resultado</button>
      </form>
      <datalist id="lite-programas">${programas.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
    const form = slot.querySelector('form');
    const fields = form.querySelector('.lite-outcome-fields');
    function drawFields() {
      const t = form.resultado.value;
      if (t === 'venta') {
        fields.innerHTML = `
          <input name="programa" list="lite-programas" placeholder="Programa vendido (ej. 3 meses)" value="${esc(r?.programa || '')}">
          <select name="meses"><option value="">Duración del programa…</option>${[1, 2, 3, 4, 5, 6, 9, 12]
            .map((m) => `<option value="${m}" ${Number(r?.meses) === m ? 'selected' : ''}>${m} ${m === 1 ? 'mes' : 'meses'}</option>`)
            .join('')}</select>
          <input name="montoTotal" type="number" min="0" step="0.01" placeholder="Monto total de la venta (USD)" value="${esc(r?.monto_total || '')}">
          <input name="pagoInicial" type="number" min="0" step="0.01" placeholder="Cuánto pagó ahora (USD)" value="${esc(r?.pago_inicial || '')}">
          <select name="cuotas"><option value="">Forma de pago…</option><option value="1" ${Number(r?.cuotas) === 1 ? 'selected' : ''}>Pago único</option>${[2, 3, 4, 6]
            .map((c) => `<option value="${c}" ${Number(r?.cuotas) === c ? 'selected' : ''}>${c} cuotas</option>`)
            .join('')}</select>
          <select name="metodoPago"><option value="">Método de pago…</option>${METODOS.map((m) => `<option ${r?.metodo_pago === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <p class="crm-outcome-hint">Al guardar, se crea el cliente en Clientes con este pago inicial.</p>`;
      } else if (['no_cerro', 'cancelada', 'pidio_reagendar', 'reserva'].includes(t)) {
        fields.innerHTML = `
          ${t === 'reserva' ? `<input name="pagoInicial" type="number" min="0" step="0.01" placeholder="Monto de la reserva (USD)" value="${esc(r?.pago_inicial || '')}">` : ''}
          <textarea name="motivo" rows="3" placeholder="${
            t === 'cancelada' ? '¿Por qué no califica? (obligatorio)' : t === 'no_cerro' ? '¿Por qué no cerró? (objeción principal)' : 'Nota (opcional)'
          }">${esc(r?.motivo || '')}</textarea>
          ${t === 'cancelada' ? '<p class="crm-outcome-hint">La agenda pasa a Perdido y no cuenta como calificada.</p>' : ''}
          ${t === 'pidio_reagendar' ? '<p class="crm-outcome-hint">La agenda pasa a Reagendar. Cuando tenga fecha nueva, cámbiala arriba.</p>' : ''}`;
      } else if (t === 'no_show') {
        fields.innerHTML = '<p class="crm-outcome-hint">La agenda pasa a Reagendar.</p>';
      } else fields.innerHTML = '';
    }
    drawFields();
    form.resultado.addEventListener('change', drawFields);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (!data.resultado) return (form.querySelector('.lite-error').textContent = 'Elige el resultado');
      const btn = form.querySelector('.crm-outcome-save');
      btn.disabled = true;
      form.querySelector('.lite-error').textContent = '';
      try {
        const res = await put(`/ventas/${v.id}/resultado`, data);
        upsertLocal(res.venta);
        drawView();
        if (data.resultado === 'venta') {
          burst(btn, 8);
          toast('¡Venta guardada! El cliente ya está en Clientes 🎉');
        } else toast('Resultado guardado');
        reopen();
      } catch (err) {
        form.querySelector('.lite-error').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- arranque y actualización
  draw();

  // Si llega ?agenda=<id> (ej. desde otra pantalla), abrirla.
  const pre = ctx.params.get('agenda');
  if (pre) openCard(pre);

  // Actualización silenciosa: cada 30 s con la pestaña visible (sin pisar un arrastre en curso).
  let busy = false;
  const timer = setInterval(async () => {
    if (document.hidden || isDragging() || busy || document.querySelector('.crm-column-title-input, .crm-add-column-form')) return;
    busy = true;
    try {
      const before = JSON.stringify(st.ventas.map((v) => [v.id, v.actualizado, v.etapa_id, v.orden]));
      await load();
      const after = JSON.stringify(st.ventas.map((v) => [v.id, v.actualizado, v.etapa_id, v.orden]));
      if (before !== after) drawView();
    } catch {
      /* se reintenta */
    } finally {
      busy = false;
    }
  }, 30_000);

  return () => {
    stopDrag();
    clearInterval(timer);
    st.panel?.close?.();
  };
}
