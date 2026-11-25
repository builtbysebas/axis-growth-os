// Clientes: tablero por etapas (Kanban / Lista), igual a /clientes de la versión completa.
// Panel del cliente con datos editables, pagos, renovaciones y notas.
// Los clientes nacen solos cuando una llamada se carga como «venta» en Ventas;
// el admin también puede crearlos a mano.
// Permisos: admin todo; coach ve todos pero cambia solo los suyos.
import { del, get, patch, post, put } from '../core/api.js';
import { colorOf, digits, esc, firstName, fmtDate, fmtDateTime, h, icons, initialsOf, money, norm } from '../core/dom.js';
import { enableDrag, isDragging } from '../core/dnd.js';
import { attempt, confirmDialog, createButton, expandableSearch, loading, sidePanel, toast, viewToggle } from '../core/ui.js';

const TIPO_LABELS = { entrada: 'Entrada', renovar: 'Renovación', perdido: 'Perdido' };
// Programas sugeridos (se puede escribir cualquier otro; se suman los que ya usa el negocio).
const PROGRAMAS_BASE = ['1 mes', '3 meses', '6 meses', '12 meses'];
const DEFAULT_METODOS = ['Transferencia', 'Mercado Pago', 'PayPal', 'Dlocal Go', 'Tarjeta', 'Efectivo', 'Otro'];
const EXPIRY_OPTIONS = [
  { key: 'expired', label: 'Ya venció' },
  { key: 'soon', label: 'Vence en 20 días o menos' },
  { key: 'active', label: 'Vigente' },
  { key: 'no_date', label: 'Sin fecha de fin' },
];
const RENEWAL_OPTIONS = [
  { key: 'renewed', label: 'Ya renovó' },
  { key: 'never', label: 'Nunca renovó' },
];
const PAYMENT_OPTIONS = [
  { key: 'balance', label: 'Debe saldo' },
  { key: 'paid', label: 'Pagado completo' },
];
const EMPTY_FILTERS = { coach: null, expiry: null, renewal: null, payment: null, program: null };

// ---------------------------------------------------------------- fechas simples 'YYYY-MM-DD'
function dayNum(s) {
  return Date.parse(`${s}T00:00:00Z`) / 86_400_000;
}
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

export async function render(root, ctx) {
  const { user } = ctx;
  const isAdmin = ctx.isAdmin;
  const st = {
    etapas: [],
    clientes: [],
    coaches: [],
    usuarios: [],
    metodos: DEFAULT_METODOS,
    hoy: '',
    renovarDias: 20,
    view: ctx.params.get('vista') === 'lista' ? 'lista' : 'kanban',
    search: '',
    f: { ...EMPTY_FILTERS },
    filtersOpen: false,
    panel: null,
  };

  root.innerHTML = `<div class="crm-page dx-page clientes-page">${loading()}</div>`;
  const page = root.firstElementChild;

  async function load() {
    const d = await get('/clientes');
    st.etapas = d.etapas;
    st.clientes = d.clientes.map(fix);
    st.coaches = d.coaches;
    st.usuarios = d.usuarios;
    st.metodos = d.metodos?.length ? d.metodos : DEFAULT_METODOS;
    st.hoy = d.hoy;
    st.renovarDias = d.renovarDias || 20;
  }
  try {
    await load();
  } catch (err) {
    page.innerHTML = `<div class="lite-empty">No se pudieron cargar los clientes: ${esc(err.message)}</div>`;
    return;
  }

  // ---------------------------------------------------------------- utilidades
  function fix(c) {
    return { ...c, orden: Number(c.orden) || 0, renovaciones: Number(c.renovaciones) || 0 };
  }
  function upsertLocal(c) {
    if (!c) return;
    const row = fix(c);
    const i = st.clientes.findIndex((x) => x.id === row.id);
    if (i >= 0) st.clientes[i] = row;
    else st.clientes.push(row);
  }
  const canEdit = (c) => isAdmin || (!!c.coach_id && c.coach_id === user.id);
  const usersById = () => new Map(st.usuarios.map((u) => [u.id, u]));

  function daysUntilEnd(c) {
    if (!c.vence) return null;
    return Math.round(dayNum(c.vence) - dayNum(st.hoy));
  }
  function expiryOf(c) {
    const d = daysUntilEnd(c);
    if (d === null) return 'no_date';
    if (d < 0) return 'expired';
    if (d <= st.renovarDias) return 'soon';
    return 'active';
  }
  function expiryLabel(c) {
    const d = daysUntilEnd(c);
    if (d === null) return null;
    if (d < 0) return { text: 'Vencido', title: `Venció hace ${Math.abs(d)} día${Math.abs(d) === 1 ? '' : 's'}`, urgent: true };
    if (d === 0) return { text: 'Vence hoy', title: '', urgent: true };
    return { text: `Vence en ${d}d`, title: `Vence el ${fmtDate(c.vence)}`, urgent: d <= st.renovarDias };
  }
  const saldoOf = (c) => (c.saldo === '' || c.saldo === null || c.saldo === undefined ? null : Number(c.saldo));
  function paymentMatches(c, key) {
    const s = saldoOf(c);
    if (key === 'paid') return s !== null && s <= 0.009;
    return s !== null && s > 0.009;
  }
  const programKey = (c) => (c.programa || '').trim().toLowerCase() || null;

  function matchesSearch(c) {
    const q = norm(st.search.trim());
    if (!q) return true;
    const qd = digits(q);
    if (qd.length >= 4 && digits(c.telefono).includes(qd)) return true;
    return [c.nombre, c.telefono, c.email, c.instagram, c.contact_id].some((v) => norm(v).includes(q));
  }
  function matchesFilters(c, skip = null) {
    const f = st.f;
    if (skip !== 'coach' && f.coach && (f.coach === 'none' ? !!c.coach_id : c.coach_id !== f.coach)) return false;
    if (skip !== 'expiry' && f.expiry && expiryOf(c) !== f.expiry) return false;
    if (skip !== 'renewal' && f.renewal && (c.renovaciones > 0) !== (f.renewal === 'renewed')) return false;
    if (skip !== 'payment' && f.payment && !paymentMatches(c, f.payment)) return false;
    if (skip !== 'program' && f.program && programKey(c) !== f.program) return false;
    return true;
  }
  const visible = () => st.clientes.filter((c) => matchesSearch(c) && matchesFilters(c));
  const activeFilters = () => Object.values(st.f).filter((v) => v !== null).length;

  function programOptions() {
    const set = new Set(PROGRAMAS_BASE);
    for (const c of st.clientes) if (c.programa?.trim()) set.add(c.programa.trim());
    return [...set].map((p) => `<option value="${esc(p)}"></option>`).join('');
  }
  const metodoOptions = (selected = '', { empty = 'Método de pago…' } = {}) =>
    `<option value="">${esc(empty)}</option>${st.metodos.map((m) => `<option value="${esc(m)}" ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('')}`;
  const coachOptions = (selected = '') =>
    `<option value="">Sin asignar</option>${st.coaches.map((u) => `<option value="${esc(u.id)}" ${u.id === selected ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}`;

  // ---------------------------------------------------------------- pantalla
  function draw() {
    page.innerHTML = `
      <div class="crm-toolbar">
        <div>
          <span class="crm-eyebrow">CRM</span>
          <h1>Clientes</h1>
        </div>
        <div class="crm-toolbar-actions">
          <span class="lite-search-slot"></span>
          ${viewToggle(
            [
              { key: 'kanban', label: 'Kanban' },
              { key: 'lista', label: 'Lista' },
            ],
            st.view,
          )}
          ${isAdmin ? createButton('Crear', 'data-create') : ''}
        </div>
      </div>
      <div class="lite-filters-slot"></div>
      <div class="lite-view"></div>`;
    page.querySelector('.lite-search-slot').replaceWith(
      expandableSearch({
        placeholder: 'Buscar nombre, teléfono, email, Instagram, contact ID…',
        value: st.search,
        onInput: (v) => {
          st.search = v;
          drawBody();
        },
      }),
    );
    drawBody();
  }

  function drawBody() {
    const slot = page.querySelector('.lite-filters-slot');
    if (slot) slot.innerHTML = filtersHtml();
    drawView();
  }

  function drawView() {
    const box = page.querySelector('.lite-view');
    if (!box) return;
    const list = visible();
    box.innerHTML = st.view === 'kanban' ? boardHtml(list) : listHtml(list);
  }

  // ---------------------------------------------------------------- filtros (como ClientFiltersBar)
  function chip(group, key, label, count, { selected, avatar = '' } = {}) {
    return `<button type="button" class="crm-chip${avatar ? '' : ' crm-chip-plain'}${selected ? ' active' : ''}" data-filter="${group}" data-val="${esc(key ?? '')}">${avatar}${esc(label)}${
      count !== undefined ? `<span class="crm-chip-count">${count}</span>` : ''
    }</button>`;
  }

  function filtersHtml() {
    const base = st.clientes.filter(matchesSearch);
    const pool = (skip) => base.filter((c) => matchesFilters(c, skip));
    const f = st.f;
    const active = activeFilters();
    const shown = visible().length;
    const rows = [];

    const coachPool = pool('coach');
    const coachIds = new Set(st.clientes.map((c) => c.coach_id).filter(Boolean));
    const byId = usersById();
    const coaches = [...st.coaches];
    for (const id of coachIds) if (!coaches.some((u) => u.id === id) && byId.get(id)) coaches.push(byId.get(id));
    if (coaches.length) {
      rows.push(`
        <div class="crm-filter-row">
          <span class="crm-filter-label">Coach</span>
          ${chip('coach', '', 'Todos', undefined, { selected: f.coach === null })}
          ${coaches
            .map((u) =>
              chip('coach', u.id, firstName(u), coachPool.filter((c) => c.coach_id === u.id).length, {
                selected: f.coach === u.id,
                avatar: `<span class="crm-chip-avatar" style="background:${colorOf(u.id)}">${esc(initialsOf(u.nombre))}</span>`,
              }),
            )
            .join('')}
          ${
            st.clientes.some((c) => !c.coach_id)
              ? chip('coach', 'none', 'Sin coach', coachPool.filter((c) => !c.coach_id).length, { selected: f.coach === 'none' })
              : ''
          }
        </div>`);
    }

    const expiryPool = pool('expiry');
    rows.push(`
      <div class="crm-filter-row">
        <span class="crm-filter-label">Vencimiento</span>
        ${chip('expiry', '', 'Todos', undefined, { selected: f.expiry === null })}
        ${EXPIRY_OPTIONS.map((o) =>
          chip('expiry', o.key, o.key === 'soon' ? `Vence en ${st.renovarDias} días o menos` : o.label, expiryPool.filter((c) => expiryOf(c) === o.key).length, {
            selected: f.expiry === o.key,
          }),
        ).join('')}
      </div>`);

    const renewalPool = pool('renewal');
    const paymentPool = pool('payment');
    rows.push(`
      <div class="crm-filter-row">
        <span class="crm-filter-label">Renovación</span>
        ${chip('renewal', '', 'Todos', undefined, { selected: f.renewal === null })}
        ${RENEWAL_OPTIONS.map((o) =>
          chip('renewal', o.key, o.label, renewalPool.filter((c) => (c.renovaciones > 0) === (o.key === 'renewed')).length, { selected: f.renewal === o.key }),
        ).join('')}
        <span class="crm-filter-label">Pagos</span>
        ${chip('payment', '', 'Todos', undefined, { selected: f.payment === null })}
        ${PAYMENT_OPTIONS.map((o) =>
          chip('payment', o.key, o.label, paymentPool.filter((c) => paymentMatches(c, o.key)).length, { selected: f.payment === o.key }),
        ).join('')}
      </div>`);

    // Programas agrupados sin mayúsculas; etiqueta = la escritura más usada.
    const byKey = new Map();
    for (const c of st.clientes) {
      const k = programKey(c);
      if (!k) continue;
      const names = byKey.get(k) || new Map();
      names.set(c.programa.trim(), (names.get(c.programa.trim()) || 0) + 1);
      byKey.set(k, names);
    }
    const programs = [...byKey.entries()]
      .map(([key, names]) => ({ key, label: [...names.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
    if (programs.length > 1) {
      const programPool = pool('program');
      rows.push(`
        <div class="crm-filter-row">
          <span class="crm-filter-label">Programa</span>
          ${chip('program', '', 'Todos', undefined, { selected: f.program === null })}
          ${programs.map((p) => chip('program', p.key, p.label, programPool.filter((c) => programKey(c) === p.key).length, { selected: f.program === p.key })).join('')}
        </div>`);
    }

    if (active > 0) {
      rows.push(`
        <div class="crm-filter-row">
          <span class="crm-filter-label">Mostrando ${shown} de ${st.clientes.length}</span>
          <button type="button" class="crm-chip crm-chip-plain" data-clear-filters>✕ Limpiar ${active === 1 ? 'filtro' : `${active} filtros`}</button>
        </div>`);
    }

    return `
      <div class="client-filters${st.filtersOpen ? ' open' : ''}">
        <button type="button" class="crm-chip crm-chip-plain client-filters-toggle" data-toggle-filters>
          ${st.filtersOpen ? 'Ocultar filtros' : 'Filtros'}
          ${active > 0 ? `<span class="crm-chip-count">${active}</span>` : ''}
          ${active > 0 && !st.filtersOpen ? `<span class="client-filters-toggle-info">${shown} de ${st.clientes.length}</span>` : ''}
        </button>
        ${rows.join('')}
      </div>`;
  }

  // ---------------------------------------------------------------- kanban
  function cardHtml(c, byId) {
    const coach = c.coach_id ? byId.get(c.coach_id) : null;
    const editable = canEdit(c);
    const saldo = saldoOf(c);
    const exp = expiryLabel(c);
    const mine = !isAdmin && c.coach_id === user.id;
    return `
      <div class="crm-card${mine ? ' crm-card-mine' : ''}${editable ? ' lite-draggable' : ''}" data-card="${esc(c.id)}">
        <div class="crm-card-top">
          ${
            coach
              ? `<span class="crm-card-avatar" style="background:${colorOf(coach.id)}" title="Coach: ${esc(coach.nombre)}">${esc(initialsOf(coach.nombre))}</span>`
              : '<span class="crm-card-avatar crm-card-avatar-empty" title="Sin coach">?</span>'
          }
          <span class="crm-card-name">${esc(c.nombre)}</span>
        </div>
        ${c.programa ? `<div class="crm-card-program">${esc(c.programa)}</div>` : ''}
        <div class="crm-card-bottom">
          ${coach ? `<span class="crm-card-tag">${esc(firstName(coach))}</span>` : '<span class="crm-card-tag crm-card-tag-empty">Sin asignar</span>'}
          ${saldo !== null && saldo > 0.009 ? `<span class="crm-card-days clients-payment-pending">Falta ${esc(money(saldo))}</span>` : ''}
        </div>
        ${exp ? `<span class="clients-renewal${exp.urgent ? ' urgent' : ''}" title="${esc(exp.title)}">${esc(exp.text)}</span>` : ''}
      </div>`;
  }

  function boardHtml(list) {
    const byId = usersById();
    const byStage = new Map(st.etapas.map((e) => [e.id, []]));
    const orphan = [];
    for (const c of list) (byStage.get(c.etapa_id) || orphan).push(c);
    for (const arr of byStage.values()) arr.sort((a, b) => a.orden - b.orden || String(a.creado).localeCompare(String(b.creado)));
    const empty = !st.clientes.length;
    return `
      ${empty ? '<p class="crm-panel-notice clientes-empty-note">Todavía no hay clientes: se cargan solos cuando marcas una venta en Ventas.</p>' : ''}
      <div class="crm-board">
        ${st.etapas
          .map(
            (e) => `
          <div class="crm-column" data-stage="${esc(e.id)}">
            <div class="crm-column-header">
              <span class="crm-column-title">${esc(e.nombre)}${e.tipo ? `<span class="crm-column-entry-badge">${esc(TIPO_LABELS[e.tipo] || e.tipo)}</span>` : ''}</span>
              <span class="crm-column-count">${byStage.get(e.id).length}</span>
              ${isAdmin ? `<div class="decision-menu-wrapper"><button type="button" class="decision-menu-btn" title="Opciones" data-stage-menu="${esc(e.id)}">⋮</button></div>` : ''}
            </div>
            <div class="crm-column-body">${byStage.get(e.id).map((c) => cardHtml(c, byId)).join('')}</div>
          </div>`,
          )
          .join('')}
        ${isAdmin ? `<div class="crm-column crm-add-column"><button type="button" class="crm-add-column-btn btn-secondary" data-add-stage>${icons.plus} Agregar columna</button></div>` : ''}
      </div>
      ${orphan.length ? `<p class="lite-hint">${orphan.length} cliente(s) sin columna: ábrelos desde la Lista y elige su etapa.</p>` : ''}`;
  }

  // ---------------------------------------------------------------- lista
  function listHtml(list) {
    const byId = usersById();
    const stages = new Map(st.etapas.map((e) => [e.id, e]));
    const sorted = [...list].sort((a, b) => {
      if (!a.vence) return 1;
      if (!b.vence) return -1;
      return a.vence.localeCompare(b.vence);
    });
    const filtered = sorted.length !== st.clientes.length;
    return `
      <div class="clients-table-wrap">
        <table class="clients-table">
          <thead><tr><th>Cliente</th><th>Coach</th><th>Programa</th><th>Pagado</th><th>Inicio</th><th>Vence</th><th>Renovó</th><th>Etapa</th></tr></thead>
          <tbody>
            ${sorted
              .map((c) => {
                const coach = c.coach_id ? byId.get(c.coach_id) : null;
                const stage = stages.get(c.etapa_id);
                const exp = expiryLabel(c);
                const saldo = saldoOf(c);
                return `<tr data-card="${esc(c.id)}">
                  <td class="clients-table-name">${esc(c.nombre)}</td>
                  <td>${
                    coach
                      ? `<span class="clients-table-coach"><span class="crm-chip-avatar" style="background:${colorOf(coach.id)}">${esc(initialsOf(coach.nombre))}</span>${esc(firstName(coach))}</span>`
                      : '<span class="crm-card-tag-empty">Sin asignar</span>'
                  }</td>
                  <td>${esc(c.programa || '—')}</td>
                  <td>${
                    c.ticket !== ''
                      ? `${esc(money(c.pagado))} / ${esc(money(c.ticket))}${saldo !== null && saldo > 0.009 ? `<span class="clients-renewal urgent">Falta ${esc(money(saldo))}</span>` : ''}`
                      : esc(money(c.pagado))
                  }</td>
                  <td>${esc(c.inicio ? fmtDate(c.inicio) : '—')}</td>
                  <td>${esc(c.vence ? fmtDate(c.vence) : '—')}${exp ? `<span class="clients-renewal${exp.urgent ? ' urgent' : ''}" title="${esc(exp.title)}">${esc(exp.text)}</span>` : ''}</td>
                  <td>${
                    c.renovaciones
                      ? `${c.renovaciones === 1 ? '1 vez' : `${c.renovaciones} veces`}${c.ultima_renovacion ? `<span class="clients-renewal">Última ${esc(fmtDate(c.ultima_renovacion))}</span>` : ''}`
                      : '<span class="crm-card-tag-empty">No</span>'
                  }</td>
                  <td>${stage ? `<span class="clients-status">${esc(stage.nombre)}</span>` : '—'}</td>
                </tr>`;
              })
              .join('')}
            ${
              !sorted.length
                ? `<tr><td colspan="8" class="clients-table-empty">${
                    filtered
                      ? 'Ningún cliente coincide con la búsqueda o los filtros.'
                      : 'Todavía no hay clientes: se cargan solos cuando marcas una venta en Ventas.'
                  }</td></tr>`
                : ''
            }
          </tbody>
        </table>
      </div>`;
  }

  // ---------------------------------------------------------------- mover (arrastrar o desde el panel)
  async function moveClient(id, etapaId, beforeId = null) {
    const c = st.clientes.find((x) => x.id === id);
    if (!c) return;
    const prev = { etapa_id: c.etapa_id, orden: c.orden };
    const col = st.clientes.filter((x) => x.etapa_id === etapaId && x.id !== id).sort((a, b) => a.orden - b.orden);
    const before = beforeId ? col.find((x) => x.id === beforeId) : null;
    const after = before ? col[col.indexOf(before) - 1] : null;
    c.etapa_id = etapaId;
    c.orden = before ? (after ? (after.orden + before.orden) / 2 : before.orden - 1) : (col.at(-1)?.orden ?? 0) + 1;
    drawBody();
    try {
      const r = await post(`/clientes/${id}/mover`, { etapaId, beforeId: beforeId || null });
      upsertLocal(r.cliente);
      drawBody();
      return true;
    } catch (err) {
      Object.assign(c, prev);
      drawBody();
      toast(err.message, { error: true });
      return false;
    }
  }

  const stopDrag = enableDrag(page, {
    item: '.crm-card[data-card]',
    zone: '.crm-column[data-stage]',
    list: (col) => col.querySelector('.crm-column-body'),
    canDrag: (el) => {
      const c = st.clientes.find((x) => x.id === el.dataset.card);
      return !!c && canEdit(c) && st.view === 'kanban';
    },
    overlayClass: 'crm-card-overlay',
    onDrop: ({ item, zone, before }) => moveClient(item.dataset.card, zone.dataset.stage, before?.dataset.card || null),
  });

  page.addEventListener('click', (e) => {
    const t = e.target;
    const f = t.closest('[data-filter]');
    if (f) {
      const key = f.dataset.filter;
      const val = f.dataset.val || null;
      st.f[key] = val === null || st.f[key] === val ? null : val;
      drawBody();
      return;
    }
    if (t.closest('[data-clear-filters]')) {
      st.f = { ...EMPTY_FILTERS };
      drawBody();
      return;
    }
    if (t.closest('[data-toggle-filters]')) {
      st.filtersOpen = !st.filtersOpen;
      drawBody();
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
    if (t.closest('[data-add-stage]')) return addStage();
    const menu = t.closest('[data-stage-menu]');
    if (menu) return openStageMenu(menu);
    const card = t.closest('[data-card]');
    if (card) openClient(card.dataset.card);
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
        ${e.tipo !== 'renovar' ? '<button type="button" data-act="renovar">🔁 Marcar como Renovación</button>' : ''}
        ${e.tipo !== 'perdido' ? '<button type="button" data-act="perdido">🚫 Marcar como Perdido</button>' : ''}
        ${e.tipo ? '<button type="button" data-act="sin-marca">○ Quitar marca</button>' : ''}
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
        const input = h(`<input class="crm-column-title-input" value="${esc(e.nombre)}" maxlength="80">`);
        title.replaceWith(input);
        input.focus();
        input.select();
        const commit = async () => {
          const nombre = input.value.trim();
          if (nombre && nombre !== e.nombre) {
            const r = await attempt(() => patch(`/cliente-etapas/${e.id}`, { nombre }));
            if (r) st.etapas = r.etapas;
          }
          drawView();
        };
        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (k) => k.key === 'Enter' && input.blur());
      } else if (['entrada', 'renovar', 'perdido', 'sin-marca'].includes(act)) {
        const r = await attempt(() => patch(`/cliente-etapas/${e.id}`, { tipo: act === 'sin-marca' ? '' : act }));
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
        const r = await attempt(() => put('/cliente-etapas/orden', { ids: st.etapas.map((x) => x.id) }));
        if (r) st.etapas = r.etapas;
      } else if (act === 'delete') {
        if (!(await confirmDialog(`¿Eliminar la columna «${e.nombre}»?`, { ok: 'Eliminar', danger: true }))) return;
        const r = await attempt(() => del(`/cliente-etapas/${e.id}`));
        if (r) {
          st.etapas = r.etapas;
          drawView();
        }
      }
    });
  }

  function addStage() {
    const btn = page.querySelector('[data-add-stage]');
    if (!btn) return;
    const form = h(
      `<form class="crm-add-column-form lite-form"><input class="lite-input" placeholder="Nombre de la columna" maxlength="80" required><div class="lite-actions"><button type="submit" class="crm-create-btn btn-sm">Agregar</button><button type="button" class="btn-ghost" data-cancel>Cancelar</button></div></form>`,
    );
    btn.replaceWith(form);
    const input = form.querySelector('input');
    input.focus();
    form.querySelector('[data-cancel]').onclick = () => drawView();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!input.value.trim()) return;
      const r = await attempt(() => post('/cliente-etapas', { nombre: input.value }));
      if (r) st.etapas = r.etapas;
      drawView();
    });
  }

  // ---------------------------------------------------------------- crear (admin)
  function openCreate() {
    const p = sidePanel('Nuevo cliente');
    p.body.innerHTML = `
      <form class="crm-create-form" novalidate>
        <label>Nombre<input name="nombre" required autocomplete="off" maxlength="200"></label>
        <label>Teléfono<input name="telefono" autocomplete="off" inputmode="tel"></label>
        <label>Email<input name="email" type="email" autocomplete="off"></label>
        <label>Instagram<input name="instagram" autocomplete="off" placeholder="usuario"></label>
        <label>Contact ID (ManyChat)<input name="contact_id" autocomplete="off"></label>
        <label>Coach<select name="coach_id">${coachOptions('')}</select></label>
        <label>Programa<input name="programa" list="cl-programas" autocomplete="off"></label>
        <div class="lite-grid2">
          <label>Meses<input name="meses" type="number" min="1" max="120" inputmode="numeric"></label>
          <label>Ticket (total vendido)<input name="ticket" type="number" min="0" step="0.01" inputmode="decimal"></label>
        </div>
        <div class="lite-grid2">
          <label>Inicio<input name="inicio" type="date" value="${esc(st.hoy)}"></label>
          <label>Vence<input name="vence" type="date"></label>
        </div>
        <span class="crm-field-hint">Si dejas «Vence» vacío, se calcula: inicio + meses.</span>
        <div class="lite-grid2">
          <label>Pago inicial (opcional)<input name="pagoInicial" type="number" min="0" step="0.01" inputmode="decimal"></label>
          <label>Método de pago<select name="metodo">${metodoOptions('')}</select></label>
        </div>
        <datalist id="cl-programas">${programOptions()}</datalist>
        <p class="lite-error" role="alert"></p>
        <button type="submit">Crear cliente</button>
      </form>`;
    const form = p.body.querySelector('form');
    form.querySelector('input').focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const err = form.querySelector('.lite-error');
      if (!data.nombre.trim()) return (err.textContent = 'Falta el nombre');
      if (Number(data.pagoInicial) > 0 && !data.metodo) return (err.textContent = 'Elige el método del pago inicial');
      for (const k of Object.keys(data)) if (data[k] === '') delete data[k];
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await post('/clientes', data);
        upsertLocal(r.cliente);
        p.close();
        drawBody();
        toast('Cliente creado');
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- panel del cliente
  async function openClient(id, { tab = null } = {}) {
    const base = st.clientes.find((x) => x.id === id);
    if (!base) return;
    if (st.panel?.id !== id) {
      st.panel?.close?.();
      const p = sidePanel(base.nombre, {
        wide: true,
        onClose: () => {
          st.panel = null;
          ctx.setParams({ cliente: null });
        },
      });
      st.panel = { id, p, close: p.close, tab: 'pagos', payFor: '', d: null };
      bindPanel(st.panel);
      ctx.setParams({ cliente: id });
      p.body.innerHTML = loading();
    }
    if (tab) st.panel.tab = tab;
    await refreshPanel();
  }

  async function refreshPanel() {
    const panel = st.panel;
    if (!panel) return;
    let d;
    try {
      d = await get(`/clientes/${panel.id}`);
    } catch (err) {
      if (st.panel !== panel) return;
      if (err.status === 404) {
        st.clientes = st.clientes.filter((x) => x.id !== panel.id);
        drawBody();
      }
      panel.p.body.innerHTML = `<div class="lite-empty">${esc(err.message)}</div>`;
      return;
    }
    if (st.panel !== panel) return;
    upsertLocal(d.cliente);
    drawBody();
    panel.d = d;
    renderPanel(panel);
  }

  function field(key, label, value, editable, { type = 'text', cls = '', display = null, full = false } = {}) {
    const shown = display ?? value;
    return `
      <div class="crm-field ${cls}${full ? ' clientes-field-full' : ''}" data-field="${key}" data-type="${type}">
        <span class="crm-field-label">${esc(label)}</span>
        <span class="${editable ? 'editable ' : ''}crm-field-value${type === 'textarea' ? ' clientes-field-multiline' : ''}" data-raw="${esc(value)}" ${editable ? 'tabindex="0" role="button"' : ''}>${esc(shown) || '—'}</span>
      </div>`;
  }

  function renderPanel(panel) {
    const { p, d } = panel;
    const c = d.cliente;
    const editable = d.puedeEditar;
    const byId = usersById();
    const coach = c.coach_id ? byId.get(c.coach_id) : null;
    const saldo = saldoOf(c);
    const exp = expiryLabel(c);
    const tab = panel.tab;
    p.setTitle(c.nombre);
    p.body.innerHTML = `
      ${
        !editable
          ? `<p class="crm-panel-notice crm-panel-readonly">Solo lectura${coach ? `: es de ${esc(coach.nombre)}` : ''}. Puedes ver todo, pero solo su coach o un admin pueden cambiarlo.</p>`
          : ''
      }
      ${
        d.venta
          ? `<p class="crm-panel-notice clientes-origin">Vino de una venta en Ventas${d.venta.agendada ? ` (agendó el ${esc(fmtDate(d.venta.agendada))})` : ''}${
              d.venta.closer ? ` · closer ${esc(d.venta.closer)}` : ''
            }${d.venta.setter ? ` · setter ${esc(d.venta.setter)}` : ''}. <a href="/ventas?agenda=${esc(c.venta_id)}" data-link>Ver agenda →</a></p>`
          : ''
      }
      <div class="clientes-summary">
        <div>
          <span class="crm-field-label">Pagos</span>
          <p class="clients-payment-summary">${
            c.ticket !== ''
              ? `${esc(money(c.pagado))} / ${esc(money(c.ticket))}${saldo !== null && saldo > 0.009 ? `<span class="clients-payment-pending"> — Saldo: ${esc(money(saldo))}</span>` : saldo !== null ? ' <span class="lite-pill green">Pagado completo</span>' : ''}`
              : `${esc(money(c.pagado))} <span class="clientes-muted">· sin ticket cargado</span>`
          }</p>
        </div>
        ${exp ? `<span class="lite-pill ${exp.urgent ? 'red' : 'indigo'}" title="${esc(exp.title)}">${esc(exp.text)}</span>` : ''}
      </div>
      ${field('contact_id', 'Contact ID (ManyChat)', c.contact_id, editable, { cls: 'crm-field-contact-id' })}
      <div class="lite-grid2 clientes-fields">
        ${field('nombre', 'Nombre', c.nombre, editable)}
        <div>
          ${field('telefono', 'Teléfono', c.telefono, editable, { type: 'tel' })}
          ${digits(c.telefono).length >= 6 ? `<a class="clientes-wa-link" href="https://wa.me/${esc(digits(c.telefono))}" target="_blank" rel="noopener">Abrir WhatsApp</a>` : ''}
        </div>
        ${field('email', 'Email', c.email, editable, { type: 'email' })}
        ${field('instagram', 'Instagram', c.instagram, editable)}
        <div class="crm-field">
          <span class="crm-field-label">Coach</span>
          <select data-select="coach_id" ${isAdmin ? '' : 'disabled'} title="${isAdmin ? '' : 'Solo un admin puede cambiar la coach'}">${coachOptions(c.coach_id)}</select>
        </div>
        <div class="crm-field">
          <span class="crm-field-label">Etapa</span>
          <select data-move ${editable ? '' : 'disabled'}>${st.etapas
            .map((e) => `<option value="${esc(e.id)}" ${e.id === c.etapa_id ? 'selected' : ''}>${esc(e.nombre)}</option>`)
            .join('')}${c.etapa_id ? '' : '<option value="" selected>Sin columna</option>'}</select>
        </div>
        ${field('programa', 'Programa', c.programa, editable, { type: 'programa' })}
        ${field('meses', 'Meses', c.meses, editable, { type: 'number', display: c.meses ? `${c.meses} ${Number(c.meses) === 1 ? 'mes' : 'meses'}` : '' })}
        ${field('ticket', 'Ticket (total vendido)', c.ticket, editable, { type: 'money', display: c.ticket !== '' ? money(c.ticket) : '' })}
        ${field('inicio', 'Inicio del programa', c.inicio, editable, { type: 'date', display: c.inicio ? fmtDate(c.inicio) : '' })}
        ${field('vence', 'Vence el programa', c.vence, editable, { type: 'date', display: c.vence ? fmtDate(c.vence) : '' })}
      </div>
      <p class="clients-program-dates-note">A ${st.renovarDias} días de vencer, el cliente pasa solo a la columna de Renovación (una vez por fecha; si lo sacas de ahí, se respeta).</p>
      ${field('notas', 'Notas generales', c.notas, editable, { type: 'textarea', full: true })}
      <div class="crm-tabs" role="tablist">
        <button type="button" role="tab" data-tab="pagos" class="${tab === 'pagos' ? 'active' : ''}" aria-selected="${tab === 'pagos'}">Pagos (${d.pagos.length})</button>
        <button type="button" role="tab" data-tab="renovaciones" class="${tab === 'renovaciones' ? 'active' : ''}" aria-selected="${tab === 'renovaciones'}">Renovaciones (${d.renovaciones.length})</button>
        <button type="button" role="tab" data-tab="notas" class="${tab === 'notas' ? 'active' : ''}" aria-selected="${tab === 'notas'}">Notas (${d.notas.length})</button>
      </div>
      <div class="clientes-tab">${tab === 'renovaciones' ? renovacionesHtml(d, editable) : tab === 'notas' ? notasHtml(d, editable) : pagosHtml(d, editable, panel.payFor)}</div>
      ${isAdmin ? '<button type="button" class="crm-delete-btn" data-delete>Eliminar cliente</button>' : ''}`;
  }

  function pagosHtml(d, editable, payFor) {
    const c = d.cliente;
    const totalRenov = Number(c.pagado_renov) || 0;
    return `
      <div class="crm-notes">
        <p class="clientes-pay-total">Venta: <strong>${esc(money(c.pagado))}</strong>${c.ticket !== '' ? ` de ${esc(money(c.ticket))}` : ''}${
          totalRenov ? ` · Renovaciones: <strong>${esc(money(totalRenov))}</strong>` : ''
        }</p>
        ${!d.pagos.length ? '<p class="crm-notes-empty">Sin pagos registrados todavía.</p>' : ''}
        ${d.pagos
          .map(
            (pg) => `
          <div class="clients-payment-item clientes-payment-row" data-pago="${esc(pg.id)}">
            <span class="clients-payment-amount">${esc(money(pg.monto))}</span>
            <input type="date" class="clients-payment-date-input" data-pay-date value="${esc(pg.fecha)}" max="${esc(st.hoy)}" aria-label="Fecha del pago" ${editable ? '' : 'disabled'}>
            <select class="pm-inline-select" data-pay-metodo aria-label="Método de pago" ${editable ? '' : 'disabled'}>${metodoOptions(pg.metodo, { empty: 'Sin método' })}${
              pg.metodo && !st.metodos.includes(pg.metodo) ? `<option value="${esc(pg.metodo)}" selected>${esc(pg.metodo)}</option>` : ''
            }</select>
            ${pg.renovacion_id ? `<span class="lite-pill indigo">Renovación${pg.renovacion_programa ? ` · ${esc(pg.renovacion_programa)}` : ''}</span>` : ''}
            ${pg.nota ? `<span class="clients-payment-note">${esc(pg.nota)}</span>` : ''}
            ${isAdmin ? `<button type="button" class="btn-ghost clientes-pay-del" data-pay-del title="Borrar pago" aria-label="Borrar pago">${icons.trash}</button>` : ''}
          </div>`,
          )
          .join('')}
        ${
          editable
            ? `<form class="crm-add-note-form clientes-pay-form" novalidate>
            <span class="crm-field-label">Registrar pago</span>
            <div class="lite-grid2">
              <input name="monto" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Monto" required>
              <input name="fecha" type="date" value="${esc(st.hoy)}" max="${esc(st.hoy)}" aria-label="Fecha del pago">
            </div>
            <select name="metodo" required>${metodoOptions('')}</select>
            ${
              d.renovaciones.length
                ? `<select name="renovacionId" aria-label="A qué corresponde el pago"><option value="">Corresponde a la venta original</option>${d.renovaciones
                    .map(
                      (r) =>
                        `<option value="${esc(r.id)}" ${r.id === payFor ? 'selected' : ''}>Renovación ${esc(r.programa)} (${esc(fmtDate(r.fecha))})</option>`,
                    )
                    .join('')}</select>`
                : ''
            }
            <input name="nota" placeholder="Nota (opcional)" maxlength="300">
            <p class="lite-error" role="alert"></p>
            <button type="submit">Registrar pago</button>
          </form>`
            : ''
        }
      </div>`;
  }

  function renovacionesHtml(d, editable) {
    return `
      <div class="crm-notes">
        ${!d.renovaciones.length ? '<p class="crm-notes-empty">Sin renovaciones todavía.</p>' : ''}
        ${d.renovaciones
          .map((r) => {
            const total = Number(r.monto_total) || 0;
            const pagado = Number(r.pagado) || 0;
            const pend = total - pagado;
            return `
            <div class="client-renewal-item">
              <div class="client-renewal-header">
                <span class="client-renewal-program">${esc(r.programa || 'Renovación')}</span>
                <span class="client-renewal-date">${esc(fmtDate(r.fecha))}</span>
              </div>
              <div class="client-renewal-meta">
                ${r.meses ? `<span>${esc(r.meses)} ${Number(r.meses) === 1 ? 'mes' : 'meses'}</span>` : ''}
                ${r.inicio && r.vence ? `<span>Del ${esc(fmtDate(r.inicio))} al ${esc(fmtDate(r.vence))}</span>` : ''}
                <span>${esc(money(pagado))} / ${esc(money(total))}</span>
                ${pend > 0.009 ? `<span class="clients-payment-pending">Falta ${esc(money(pend))}</span>` : '<span class="clientes-ok">Pagada</span>'}
              </div>
              ${editable && pend > 0.009 ? `<button type="button" class="client-renewal-add-payment-btn" data-pay-renov="${esc(r.id)}">+ Registrar pago</button>` : ''}
            </div>`;
          })
          .join('')}
        ${editable ? '<button type="button" class="client-renewal-add-payment-btn" data-new-renov>+ Nueva renovación</button><div class="clientes-renov-slot"></div>' : ''}
      </div>`;
  }

  function notasHtml(d, editable) {
    return `
      <div class="crm-notes">
        ${!d.notas.length ? '<p class="crm-notes-empty">Sin notas todavía.</p>' : ''}
        ${d.notas
          .map((n) => `<div class="crm-note"><div class="crm-note-meta"><span>${esc(n.autor || '')}</span><span>${esc(fmtDateTime(n.creado))}</span></div><p>${esc(n.texto)}</p></div>`)
          .join('')}
        ${
          editable
            ? '<form class="crm-add-note-form clientes-note-form"><textarea rows="3" placeholder="Agregar una nota de seguimiento…" maxlength="5000"></textarea><button type="submit">Agregar nota</button></form>'
            : ''
        }
      </div>`;
  }

  function renewalFormHtml(c) {
    return `
      <form class="crm-outcome clientes-renov-form" novalidate>
        <span class="crm-field-label">Nueva renovación</span>
        <label class="clientes-inline-label">Fecha de la renovación<input name="fecha" type="date" value="${esc(st.hoy)}" max="${esc(st.hoy)}"></label>
        <input name="programa" list="cl-programas-panel" placeholder="Programa" value="${esc(c.programa || '')}" maxlength="200" autocomplete="off">
        <datalist id="cl-programas-panel">${programOptions()}</datalist>
        <input name="meses" type="number" min="1" max="120" inputmode="numeric" placeholder="Meses (obligatorio)">
        <p class="crm-outcome-hint" data-renov-hint></p>
        <input name="montoTotal" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Monto total">
        <input name="pagoInicial" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Pago ahora (opcional)">
        <select name="metodo">${metodoOptions('', { empty: 'Método del pago…' })}</select>
        <p class="lite-error" role="alert"></p>
        <div class="client-renewal-form-actions">
          <button type="submit" class="crm-outcome-save">Registrar renovación</button>
          <button type="button" class="client-renewal-cancel-btn" data-cancel-renov>Cancelar</button>
        </div>
      </form>`;
  }

  // Listeners del panel: delegados y una sola vez por panel (el contenido se redibuja).
  function bindPanel(panel) {
    const { p } = panel;
    const body = p.body;
    const cur = () => panel.d?.cliente;
    const canChange = () => !!panel.d?.puedeEditar;

    async function save(fields) {
      const id = cur().id;
      const r = await attempt(() => patch(`/clientes/${id}`, fields));
      if (r) {
        upsertLocal(r.cliente);
        drawBody();
        toast('Guardado ✓');
      }
      await refreshPanel();
    }

    // Campos que se editan al tocarlos y se guardan al salir (como EditableField de la versión completa).
    function startEdit(val) {
      const f = val.closest('[data-field]');
      const type = f.dataset.type;
      const raw = val.dataset.raw;
      let input;
      if (type === 'textarea') input = h(`<textarea rows="4" maxlength="5000">${esc(raw)}</textarea>`);
      else if (type === 'programa') input = h(`<input type="text" list="cl-programas-edit" value="${esc(raw)}" maxlength="200" autocomplete="off">`);
      else if (type === 'number') input = h(`<input type="number" min="1" max="120" inputmode="numeric" value="${esc(raw)}">`);
      else if (type === 'money') input = h(`<input type="number" min="0" step="0.01" inputmode="decimal" value="${esc(raw)}">`);
      else input = h(`<input type="${['date', 'email', 'tel'].includes(type) ? type : 'text'}" value="${esc(raw)}" maxlength="200">`);
      val.replaceWith(input);
      if (type === 'programa') input.insertAdjacentHTML('afterend', `<datalist id="cl-programas-edit">${programOptions()}</datalist>`);
      input.focus();
      let done = false;
      const commit = async () => {
        if (done) return;
        done = true;
        const nv = input.value.trim();
        if (nv === String(raw).trim()) return renderPanel(panel);
        await save({ [f.dataset.field]: nv });
      };
      input.addEventListener('blur', commit, { once: true });
      input.addEventListener('keydown', (k) => {
        if (k.key === 'Enter' && type !== 'textarea') input.blur();
        if (k.key === 'Escape') {
          k.stopPropagation();
          done = true;
          renderPanel(panel);
        }
      });
    }

    body.addEventListener('click', async (ev) => {
      const t = ev.target;
      if (!panel.d) return;
      const c = cur();
      const val = t.closest('.crm-field-value.editable');
      if (val && canChange()) return startEdit(val);
      const tabBtn = t.closest('[data-tab]');
      if (tabBtn) {
        panel.tab = tabBtn.dataset.tab;
        panel.payFor = '';
        return renderPanel(panel);
      }
      const payRenov = t.closest('[data-pay-renov]');
      if (payRenov) {
        panel.tab = 'pagos';
        panel.payFor = payRenov.dataset.payRenov;
        renderPanel(panel);
        body.querySelector('.clientes-pay-form input[name=monto]')?.focus();
        return;
      }
      const newRenov = t.closest('[data-new-renov]');
      if (newRenov) {
        const slot = body.querySelector('.clientes-renov-slot');
        newRenov.remove();
        slot.innerHTML = renewalFormHtml(c);
        slot.querySelector('input[name=meses]').focus();
        return;
      }
      if (t.closest('[data-cancel-renov]')) return renderPanel(panel);
      const delPay = t.closest('[data-pay-del]');
      if (delPay) {
        const pg = panel.d.pagos.find((x) => x.id === delPay.closest('[data-pago]')?.dataset.pago);
        if (!pg) return;
        if (!(await confirmDialog(`¿Borrar el pago de ${money(pg.monto)} del ${fmtDate(pg.fecha)}? No se puede deshacer.`, { ok: 'Borrar', danger: true }))) return;
        const r = await attempt(() => del(`/cliente-pagos/${pg.id}`));
        if (r) {
          upsertLocal(r.cliente);
          drawBody();
          toast('Pago borrado');
          await refreshPanel();
        }
        return;
      }
      if (t.closest('[data-delete]')) {
        if (!(await confirmDialog(`¿Eliminar a ${c.nombre}? Se borran también sus pagos, renovaciones y notas. No se puede deshacer.`, { ok: 'Eliminar', danger: true }))) return;
        const r = await attempt(() => del(`/clientes/${c.id}`));
        if (r) {
          st.clientes = st.clientes.filter((x) => x.id !== c.id);
          p.close();
          drawBody();
          toast('Cliente eliminado');
        }
      }
    });

    body.addEventListener('keydown', (ev) => {
      const val = ev.target.closest?.('.crm-field-value.editable');
      if (val && canChange() && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        startEdit(val);
      }
    });

    body.addEventListener('change', async (ev) => {
      const t = ev.target;
      if (!panel.d) return;
      const id = cur().id;
      if (t.matches('[data-select="coach_id"]')) return save({ coach_id: t.value });
      if (t.matches('[data-move]')) {
        if (!t.value) return;
        const ok = await moveClient(id, t.value);
        if (ok) toast('Guardado ✓');
        return refreshPanel();
      }
      const row = t.closest('[data-pago]');
      if (row && t.matches('[data-pay-date]')) {
        if (!t.value) return;
        const r = await attempt(() => patch(`/cliente-pagos/${row.dataset.pago}`, { fecha: t.value }));
        if (r) toast('Guardado ✓');
        return refreshPanel();
      }
      if (row && t.matches('[data-pay-metodo]')) {
        const r = await attempt(() => patch(`/cliente-pagos/${row.dataset.pago}`, { metodo: t.value }));
        if (r) toast('Guardado ✓');
        return refreshPanel();
      }
    });

    // Vista previa del vencimiento al escribir los meses de una renovación.
    body.addEventListener('input', (ev) => {
      const form = ev.target.closest('.clientes-renov-form');
      if (!form || !panel.d) return;
      const c = cur();
      const hint = form.querySelector('[data-renov-hint]');
      const meses = Number(form.elements.meses.value);
      const fecha = form.elements.fecha.value || st.hoy;
      if (!(meses >= 1 && meses <= 120)) {
        hint.textContent = '';
        return;
      }
      const sigue = !!c.vence && c.vence > fecha;
      const inicio = sigue ? c.vence : fecha;
      hint.textContent = `${sigue ? 'Sigue desde que vence el actual' : 'Ya venció: arranca en la fecha de la renovación'}: del ${fmtDate(inicio)} al ${fmtDate(addMonths(inicio, meses))}.`;
    });

    body.addEventListener('submit', async (ev) => {
      const form = ev.target;
      ev.preventDefault();
      if (!panel.d) return;
      const id = cur().id;
      const err = form.querySelector('.lite-error');
      const btn = form.querySelector('button[type=submit]');
      if (form.matches('.clientes-note-form')) {
        const ta = form.querySelector('textarea');
        if (!ta.value.trim()) return;
        btn.disabled = true;
        const r = await attempt(() => post(`/clientes/${id}/notas`, { texto: ta.value }));
        btn.disabled = false;
        if (r) {
          panel.d.notas.unshift(r.nota);
          renderPanel(panel);
        }
        return;
      }
      const data = Object.fromEntries(new FormData(form));
      if (form.matches('.clientes-pay-form')) {
        if (!(Number(data.monto) > 0)) return (err.textContent = 'Escribe el monto del pago');
        if (!data.metodo) return (err.textContent = 'Elige el método de pago');
        btn.disabled = true;
        try {
          const r = await post(`/clientes/${id}/pagos`, data);
          upsertLocal(r.cliente);
          drawBody();
          toast('Pago registrado');
          panel.payFor = '';
          await refreshPanel();
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
        return;
      }
      if (form.matches('.clientes-renov-form')) {
        if (!data.programa.trim()) return (err.textContent = 'Falta el programa');
        if (!(Number(data.meses) >= 1)) return (err.textContent = 'Faltan los meses');
        if (!(Number(data.montoTotal) > 0)) return (err.textContent = 'Falta el monto total');
        if (Number(data.pagoInicial) > 0 && !data.metodo) return (err.textContent = 'Elige el método del pago');
        if (!data.pagoInicial) delete data.pagoInicial;
        btn.disabled = true;
        try {
          const r = await post(`/clientes/${id}/renovaciones`, data);
          upsertLocal(r.cliente);
          drawBody();
          toast('Renovación registrada');
          await refreshPanel();
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      }
    });
  }

  // ---------------------------------------------------------------- arranque y actualización
  draw();

  // ?cliente=<id> (ej. desde Ventas): abrirlo.
  const pre = ctx.params.get('cliente');
  if (pre && st.clientes.some((c) => c.id === pre)) openClient(pre);
  else if (pre) ctx.setParams({ cliente: null });

  // Actualización silenciosa: cada 30 s con la pestaña visible (sin pisar un arrastre ni una edición en curso).
  let busy = false;
  const sig = () => JSON.stringify(st.clientes.map((c) => [c.id, c.actualizado, c.etapa_id, c.orden, c.pagado, c.pagado_renov, c.renovaciones]));
  const timer = setInterval(async () => {
    if (document.hidden || isDragging() || busy || page.querySelector('.crm-column-title-input, .crm-add-column-form, .decision-menu')) return;
    busy = true;
    try {
      const before = sig();
      await load();
      if (before !== sig()) drawBody();
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
