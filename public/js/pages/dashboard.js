// Pantalla: Dashboard (solo admin). Mismo tablero que la versión completa:
// General (cash collected con meta, embudo, números clave, de dónde viene el cash
// y las agendas con presupuesto) y pestañas Setters / Closers.
import { get, patch, qs } from '../core/api.js';
import { todayStr } from '../core/dates.js';
import { colorOf, esc, fmtDate, icons, initialsOf, money, num, pct } from '../core/dom.js';
import { dxHeader, dxSeg, loading, rangeControls, sidePanel, toast } from '../core/ui.js';

// ---------------------------------------------------------------- íconos propios (trazos de DashIcons de la versión completa)
const svg = (p) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  arrowRight: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
  arrowUpRight: svg('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>'),
  receipt: svg('<path d="M4 3h16v18l-3-2-3 2-2-2-2 2-3-2-3 2z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="14" y2="12"/>'),
  tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
};

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'setters', label: 'Setters' },
  { key: 'closers', label: 'Closers' },
];

const TIPO_LABEL = { venta_nueva: 'Venta nueva', cuota: 'Cuota', renovacion: 'Renovación' };

// Familias de fuente: color fijo por familia (el color sigue a la fuente, nunca al puesto).
// Siempre con montos y % al lado: la rueda nunca va sola.
const GROUPS = [
  { key: 'story', label: 'Stories', color: '#2a78d6' },
  { key: 'ad', label: 'Ads', color: '#eb6834' },
  { key: 'post', label: 'Contenido corto', color: '#1baf7a' },
  { key: 'manual', label: 'Origen manual', color: '#eda100' },
  { key: 'renewal', label: 'Renovaciones', color: '#4a3aa7' },
  { key: 'none', label: 'Sin atribución', color: '#b9b4ad' },
];
const COLOR = Object.fromEntries(GROUPS.map((g) => [g.key, g.color]));

const MODES = {
  cash: {
    fmt: (v) => money(v),
    centerLabel: 'Cash collected',
    valueHead: 'Cash',
    extraHead: 'Ventas',
    extra: (s) => (s.group === 'renewal' ? `${s.pagos} pagos` : s.ventas || '—'),
    empty: 'Sin cash collected en este rango.',
    note: 'Ventas nuevas, cuotas y renovaciones del rango. Cada pago cuenta para la fuente de su venta: atribución manual, o el último contenido que la lead respondió antes de agendar.',
    unattributed: (v) => `${money(v)} sin atribución`,
  },
  agendas: {
    fmt: (v) => num(v),
    centerLabel: 'Agendas con presupuesto',
    valueHead: 'Agendas',
    extraHead: 'Compraron',
    extra: (s) => s.ventas || '—',
    empty: 'Sin agendas con presupuesto en este rango.',
    note: 'Agendas del rango (por la fecha en que llegaron) marcadas «con presupuesto», sin las canceladas. Misma atribución: manual, o el último contenido que la lead respondió antes de agendar. «Compraron» = de esas agendas, cuántas ya tienen venta.',
    unattributed: (v) => `${num(v)} ${Number(v) === 1 ? 'agenda' : 'agendas'} sin atribución`,
  },
};

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;
const DONUT_R = 56;
const DONUT_C = 2 * Math.PI * DONUT_R;
const DONUT_GAP = 2.5;

const share = (v, total) => (total > 0 ? Math.round((v / total) * 100) : 0);

export async function render(root, ctx) {
  const initialTab = TABS.some((t) => t.key === ctx.params.get('vista')) ? ctx.params.get('vista') : 'general';
  const state = {
    tab: initialTab,
    range: null,
    alive: true,
    loads: 0,
    token: 0,
    prefetchTimer: 0,
    goal: Number(ctx.ajustes?.metaCash ?? 10000),
    editingGoal: false,
  };
  const cache = new Map(); // `${vista}|${from}|${to}` → datos

  root.innerHTML = `
    <div class="crm-page dx-page dsh-page">
      <div data-head></div>
      <div data-controls></div>
      <div data-error></div>
      <div data-body>${loading()}</div>
    </div>`;
  const headEl = root.querySelector('[data-head]');
  const errorEl = root.querySelector('[data-error]');
  const bodyEl = root.querySelector('[data-body]');

  const rc = rangeControls({
    leadHtml: dxSeg(TABS, state.tab, { label: 'Vista', name: 'tab' }),
    onChange: () => {
      syncTabs();
      onRangeChange();
    },
  });
  root.querySelector('[data-controls]').replaceWith(rc.el);

  function syncTabs() {
    rc.el.querySelectorAll('[data-seg-name="tab"] [data-seg]').forEach((b) => {
      const on = b.dataset.seg === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function renderHead() {
    headEl.innerHTML = dxHeader({ eyebrow: ctx.page.group || 'Reportes', title: ctx.page.title || 'Dashboard', rangeText: state.range?.label || '' });
  }

  rc.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg-name="tab"] [data-seg]');
    if (!b || b.dataset.seg === state.tab) return;
    state.tab = b.dataset.seg;
    ctx.setParams({ vista: state.tab === 'general' ? null : state.tab });
    syncTabs();
    show();
  });

  // ---------------------------------------------------------------- carga
  const keyFor = (vista) => `${vista}|${state.range.from}|${state.range.to}`;
  const pathFor = (vista) => {
    const q = { from: state.range.from, to: state.range.to };
    if (vista === 'general') return `/dashboard${qs(q)}`;
    return `/dashboard/equipo${qs({ rol: vista === 'setters' ? 'setter' : 'closer', ...q })}`;
  };

  function busy(delta) {
    state.loads = Math.max(0, state.loads + delta);
    if (state.alive) rc.setBusy(state.loads > 0);
  }

  function onRangeChange() {
    state.range = rc.current();
    if (!state.range) return;
    renderHead();
    show();
  }

  /** Muestra la vista actual: lo guardado al instante y lo revalida en silencio. */
  async function show() {
    const vista = state.tab;
    const key = keyFor(vista);
    const token = ++state.token;
    errorEl.innerHTML = '';
    const cached = cache.get(key);
    if (cached) paint(vista, cached);
    else bodyEl.classList.add('dx-dim');
    if (!cached && state.painted !== vista) {
      bodyEl.innerHTML = loading();
      state.painted = null;
    }
    busy(1);
    try {
      const data = await get(pathFor(vista));
      cache.set(key, data);
      if (!state.alive || token !== state.token) return;
      paint(vista, data);
      if (vista === 'general') schedulePrefetch();
    } catch (err) {
      if (!state.alive || token !== state.token) return;
      if (!cached) {
        bodyEl.innerHTML = '';
        errorEl.innerHTML = `<div class="reorder-error">${esc(err.message || 'No se pudieron cargar los números')}</div>`;
      }
    } finally {
      busy(-1);
      if (state.alive && token === state.token) bodyEl.classList.remove('dx-dim');
    }
  }

  // Precarga silenciosa de Setters y Closers para el rango actual (abren al instante).
  function schedulePrefetch() {
    clearTimeout(state.prefetchTimer);
    state.prefetchTimer = setTimeout(() => {
      for (const vista of ['setters', 'closers']) {
        if (!state.alive || !state.range) return;
        const key = keyFor(vista);
        if (cache.has(key)) continue;
        get(pathFor(vista))
          .then((d) => cache.set(key, d))
          .catch(() => {});
      }
    }, 250);
  }

  function paint(vista, data) {
    if (vista !== state.tab) return;
    state.painted = vista;
    if (vista === 'general') bodyEl.innerHTML = generalHtml(data);
    else bodyEl.innerHTML = teamHtml(vista, data.filas || []);
  }

  // ---------------------------------------------------------------- General
  function heroHtml(m) {
    const goal = state.goal;
    const cash = m.cash;
    const p = goal > 0 ? (cash / goal) * 100 : null;
    const ringPct = Math.min(Math.max(p ?? 0, 0), 100);
    const goalCtl = state.editingGoal
      ? `<input type="number" min="1" step="1" class="dx-goal-input" data-goal-input value="${esc(goal)}" aria-label="Meta de cash collected">`
      : `<button type="button" class="dx-goal-edit" data-goal-edit title="Editar meta">${money(goal)}</button>`;
    return `
      <section class="dx-hero" style="--i:0">
        <div class="dx-hero-main">
          <div class="dx-hero-top">
            <span class="dx-hero-label"><span class="dx-hero-dot"></span>Cash collected</span>
            <button type="button" class="dx-hero-link" data-cash-detail>Ver de dónde viene ${I.arrowUpRight}</button>
          </div>
          <span class="dx-hero-value">${esc(money(cash))}</span>
          <div class="dx-hero-track"><div class="dx-hero-fill" style="width:${ringPct}%"></div></div>
          <span class="dx-hero-goal">Meta de ${goalCtl}${goal > cash ? ` · faltan ${esc(money(goal - cash))}` : ''}</span>
        </div>
        <div class="dx-ring" aria-label="${(p ?? 0).toFixed(0)}% de la meta">
          <svg viewBox="0 0 132 132">
            <circle class="dx-ring-track" cx="66" cy="66" r="${RING_R}"/>
            <circle class="dx-ring-fill" cx="66" cy="66" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - ringPct / 100)}" transform="rotate(-90 66 66)"/>
          </svg>
          <div class="dx-ring-text"><strong>${p === null ? '—' : `${p.toFixed(0)}%`}</strong><span>de la meta</span></div>
        </div>
      </section>`;
  }

  function stepHtml({ tone, label, chip = '', value, bar, sub, i }) {
    return `
      <div class="dx-step tone-${tone}" style="--i:${i}">
        <div class="dx-step-top">
          <span class="dx-step-label">${esc(label)}</span>
          ${chip ? `<span class="dx-step-chip">${esc(chip)}</span>` : ''}
        </div>
        <span class="dx-step-value">${esc(num(value))}</span>
        <div class="dx-step-track"><div class="dx-step-fill" style="width:${Math.min(Math.max(bar, 0), 100)}%"></div></div>
        <span class="dx-step-sub">${esc(sub)}</span>
      </div>`;
  }

  function funnelHtml(m) {
    if (!m.agendas && !m.llamadas && !m.ventas) {
      return `<div class="dx-card dsh-gap"><p class="crm-notes-empty">Sin agendas ni llamadas en este rango.</p></div>`;
    }
    const arrow = `<span class="dx-step-arrow" aria-hidden="true">${I.arrowRight}</span>`;
    const califPct = m.agendas > 0 ? (m.calificadas / m.agendas) * 100 : null;
    const ventasBar = m.llamadas > 0 ? (m.ventas / m.llamadas) * 100 : 0;
    return `
      <div class="dx-steps dsh-steps">
        ${stepHtml({ tone: 'peach', label: 'Agendas', value: m.agendas, bar: m.agendas > 0 ? 100 : 0, sub: 'por el día en que llegó la agenda', i: 1 })}
        ${arrow}
        ${stepHtml({ tone: 'indigo', label: 'Calificadas', chip: califPct === null ? '' : `${pct(califPct)} calif.`, value: m.calificadas, bar: califPct ?? 0, sub: `${num(m.canceladas)} canceladas (no califican)`, i: 2 })}
        ${arrow}
        ${stepHtml({ tone: 'indigo', label: 'Se presentaron', chip: `${pct(m.showRate)} show`, value: m.shows, bar: m.showRate ?? 0, sub: `de ${num(m.llamadas)} llamadas que ya debieron ocurrir`, i: 3 })}
        ${arrow}
        ${stepHtml({ tone: 'emerald', label: 'Cerraron', chip: `${pct(m.closeRate)} close`, value: m.ventas, bar: ventasBar, sub: 'ventas del período (por el pago inicial)', i: 4 })}
      </div>`;
  }

  function tile({ icon, tone, label, value, sub = '', i, cls = '' }) {
    return `
      <div class="dx-tile ${cls}" style="--i:${i}">
        <span class="dx-tile-icon tone-${tone}">${icon}</span>
        <span class="dx-tile-label">${esc(label)}</span>
        <span class="dx-tile-value">${esc(value)}</span>
        ${sub ? `<span class="dx-tile-sub">${sub}</span>` : ''}
      </div>`;
  }

  function tilesHtml(m) {
    const tiles = [
      tile({ icon: icons.check, tone: 'indigo', label: 'Show rate', value: pct(m.showRate), sub: `${num(m.shows)} de ${num(m.llamadas)} llamadas · ${num(m.noShows)} no show`, i: 5 }),
      tile({ icon: icons.trend, tone: 'emerald', label: 'Close rate', value: pct(m.closeRate), sub: `${num(m.ventas)} ventas de ${num(m.shows)} shows`, i: 6 }),
      tile({ icon: I.tag, tone: 'peach', label: 'Ventas', value: num(m.ventas), sub: 'con pago inicial en el rango, cuotas no cuentan', i: 7 }),
      tile({ icon: icons.money, tone: 'indigo', label: 'AOV', value: m.aov === null ? '—' : money(m.aov), sub: 'pago inicial promedio por venta', i: 8 }),
      tile({ icon: I.receipt, tone: 'peach', label: 'Facturación', value: money(m.facturacion), sub: 'valor total vendido + renovaciones', i: 9 }),
      tile({ icon: icons.money, tone: 'emerald', label: 'Cash nuevo', value: money(m.cashNuevo), sub: `+ ${esc(money(m.cashRenovaciones))} de renovaciones (${num(m.renovaciones)})`, i: 10 }),
      tile({ icon: icons.chat, tone: 'indigo', label: 'Propuestas de llamada', value: num(m.propuestas), sub: 'avisos de ManyChat', i: 11 }),
      tile({ icon: icons.link, tone: 'indigo', label: 'Links enviados', value: num(m.links), sub: 'avisos de ManyChat', i: 12 }),
      tile({ icon: icons.calendar, tone: 'emerald', label: 'Agendas con presupuesto', value: num(m.conPresupuesto), sub: `${num(m.sinPresupuesto)} sin presupuesto · ${num(Math.max(m.agendas - m.conPresupuesto - m.sinPresupuesto, 0))} sin dato`, i: 13 }),
    ];
    const warn = m.sinResultado > 0;
    tiles.push(
      tile({
        icon: warn ? I.alert : icons.phone,
        tone: warn ? 'peach' : 'emerald',
        label: 'Llamadas sin resultado',
        value: num(m.sinResultado),
        sub: warn ? 'ya pasaron y no tienen resultado: bajan el show rate · <a href="/ventas" data-link>cargar en Ventas</a>' : 'todas las llamadas pasadas tienen resultado',
        cls: warn ? 'dsh-tile-warn' : '',
        i: 14,
      }),
    );
    return `<div class="dx-tiles dsh-gap">${tiles.join('')}</div>`;
  }

  function sourcesHtml(data, modeKey) {
    const m = MODES[modeKey];
    if (!data || !(data.total > 0)) return `<div class="dx-card dsh-gap"><p class="crm-notes-empty">${esc(m.empty)}</p></div>`;
    const groups = GROUPS.map((g) => ({ ...g, value: data.sources.filter((s) => s.group === g.key).reduce((a, s) => a + s.value, 0) })).filter((g) => g.value > 0);
    let offset = 0;
    const arcs = groups
      .map((g) => {
        const len = (g.value / data.total) * DONUT_C;
        const dash = Math.max(len - DONUT_GAP, 0.01);
        const out = `<circle cx="80" cy="80" r="${DONUT_R}" class="cs-arc" data-group="${g.key}" stroke="${g.color}" stroke-dasharray="${dash} ${DONUT_C - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 80 80)"><title>${esc(`${g.label}: ${m.fmt(g.value)} (${share(g.value, data.total)}%)`)}</title></circle>`;
        offset += len;
        return out;
      })
      .join('');
    const maxV = Math.max(...data.sources.map((s) => s.value), 1);
    const center = `<span class="cs-center-label">${esc(m.centerLabel)}</span><strong>${esc(m.fmt(data.total))}</strong><span class="cs-center-sub">${data.sources.length} ${data.sources.length === 1 ? 'fuente' : 'fuentes'}</span>`;
    const unattributed = data.sources.find((s) => s.group === 'none');
    const groupData = groups.map((g) => ({ key: g.key, label: g.label, value: m.fmt(g.value), pct: share(g.value, data.total) }));
    return `
      <div class="dx-card cs-card" data-sources="${modeKey}" data-groups="${esc(JSON.stringify(groupData))}" data-center="${esc(center)}">
        <div class="cs-donut-wrap">
          <div class="cs-donut-box">
            <svg class="cs-donut" viewBox="0 0 160 160" role="img" aria-label="${esc(m.centerLabel)} por fuente">
              <circle cx="80" cy="80" r="${DONUT_R}" class="cs-track"/>
              ${arcs}
            </svg>
            <div class="cs-center" aria-live="polite">${center}</div>
          </div>
          <ul class="cs-groups">
            ${groups.map((g) => `<li data-group="${g.key}"><i style="background:${g.color}"></i><span>${esc(g.label)}</span><b>${share(g.value, data.total)}%</b></li>`).join('')}
          </ul>
        </div>
        <div class="cs-list">
          <div class="cs-list-head"><span>Fuente</span><span>${esc(m.valueHead)}</span><span>${esc(m.extraHead)}</span></div>
          ${data.sources
            .map(
              (s) => `
            <div class="cs-row" data-group="${esc(s.group)}"${s.top.length ? ` title="${esc(`Top: ${s.top.map((t) => `${t.title} (${m.fmt(t.value)})`).join(' · ')}`)}"` : ''}>
              <div class="cs-row-main">
                <span class="cs-row-label"><i style="background:${COLOR[s.group] || COLOR.none}"></i>${esc(s.label)}</span>
                <div class="cs-row-bar"><i style="width:${(s.value / maxV) * 100}%;background:${COLOR[s.group] || COLOR.none}"></i></div>
                ${s.top.length ? `<span class="cs-row-top">${esc(s.top.map((t) => t.title).join(' · '))}</span>` : ''}
              </div>
              <span class="cs-row-cash">${esc(m.fmt(s.value))}<small>${share(s.value, data.total)}%</small></span>
              <span class="cs-row-sales">${esc(m.extra(s))}</span>
            </div>`,
            )
            .join('')}
          <p class="cs-note">${esc(m.note)}${
            unattributed
              ? ` ${esc(m.unattributed(unattributed.value))} — <a href="/contenido/resultados" data-link>asígnalas en Resultados Contenido</a>.`
              : ''
          }</p>
        </div>
      </div>`;
  }

  function generalHtml(data) {
    const m = data.metrics;
    state.lastMetrics = m;
    return `
      <div class="dx-body">
        <div data-hero>${heroHtml(m)}</div>
        <span class="dx-section-label">Del agendado a la venta</span>
        ${funnelHtml(m)}
        <span class="dx-section-label">Números clave</span>
        ${tilesHtml(m)}
        <span class="dx-section-label">De dónde viene el cash</span>
        ${sourcesHtml(data.fuentes?.cash, 'cash')}
        <span class="dx-section-label">De dónde vienen las agendas con presupuesto</span>
        ${sourcesHtml(data.fuentes?.agendas, 'agendas')}
      </div>`;
  }

  // Resaltar una familia al pasar el mouse (rueda, leyenda o fila).
  function setActiveGroup(card, group) {
    card.querySelectorAll('.cs-arc').forEach((a) => a.classList.toggle('is-dim', !!group && a.dataset.group !== group));
    card.querySelectorAll('.cs-row').forEach((r) => r.classList.toggle('is-dim', !!group && r.dataset.group !== group));
    card.querySelectorAll('.cs-groups li').forEach((li) => li.classList.toggle('is-active', li.dataset.group === group));
    const center = card.querySelector('.cs-center');
    let g = null;
    try {
      g = group ? JSON.parse(card.dataset.groups).find((x) => x.key === group) : null;
    } catch {
      g = null;
    }
    center.innerHTML = g
      ? `<span class="cs-center-label">${esc(g.label)}</span><strong>${esc(g.value)}</strong><span class="cs-center-sub">${g.pct}% del total</span>`
      : card.dataset.center;
  }
  bodyEl.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-sources] [data-group]');
    if (!t) return;
    const card = t.closest('[data-sources]');
    if (card.dataset.active !== t.dataset.group) {
      card.dataset.active = t.dataset.group;
      setActiveGroup(card, t.dataset.group);
    }
  });
  bodyEl.addEventListener('mouseout', (e) => {
    const t = e.target.closest?.('[data-sources] [data-group]');
    if (!t) return;
    const card = t.closest('[data-sources]');
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-sources] [data-group]') : null;
    if (to && to.closest('[data-sources]') === card) return;
    card.dataset.active = '';
    setActiveGroup(card, null);
  });

  // ---------------------------------------------------------------- meta editable
  function repaintHero() {
    const slot = bodyEl.querySelector('[data-hero]');
    if (slot && state.lastMetrics) slot.innerHTML = heroHtml(state.lastMetrics);
  }
  async function commitGoal(input) {
    if (!state.editingGoal) return;
    state.editingGoal = false;
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0 || v === state.goal) {
      if (input.value !== '' && (!Number.isFinite(v) || v <= 0)) toast('La meta tiene que ser un monto mayor a 0', { error: true });
      repaintHero();
      return;
    }
    const prev = state.goal;
    state.goal = v;
    repaintHero();
    try {
      await patch('/ajustes', { metaCash: v });
      await ctx.reloadAjustes?.();
      toast('Meta guardada');
    } catch (err) {
      state.goal = prev;
      if (state.alive) repaintHero();
      toast(err.message || 'No se pudo guardar la meta', { error: true });
    }
  }
  bodyEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-goal-edit]')) {
      state.editingGoal = true;
      repaintHero();
      const input = bodyEl.querySelector('[data-goal-input]');
      input?.focus();
      input?.select();
      return;
    }
    if (e.target.closest('[data-cash-detail]') && state.range) openCashDetail({ ...state.range });
  });
  bodyEl.addEventListener('keydown', (e) => {
    const input = e.target.closest?.('[data-goal-input]');
    if (!input) return;
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      state.editingGoal = false;
      repaintHero();
    }
  });
  bodyEl.addEventListener('focusout', (e) => {
    const input = e.target.closest?.('[data-goal-input]');
    if (input) commitGoal(input);
  });

  // ---------------------------------------------------------------- detalle del cash
  function attributionOf(p) {
    if (p.tipo === 'renovacion') return p.coach ? `${p.coach} (coach)` : 'Renovación · sin coach asignada';
    if (p.setter && p.closer) return `${p.setter} (setter) / ${p.closer} (closer)`;
    if (p.closer) return `${p.closer} (closer)`;
    if (p.setter) return `${p.setter} (setter)`;
    return 'Sin setter ni closer';
  }

  async function openCashDetail(range) {
    const panel = sidePanel('De dónde viene el cash collected', { wide: true });
    panel.body.innerHTML = `
      <p class="crm-notes-empty">Cada pago que entró del ${esc(range.label)}: quién pagó, si es venta nueva, cuota o renovación, y de qué venta viene.</p>
      ${loading()}`;
    try {
      const data = await get(`/dashboard/cash${qs({ from: range.from, to: range.to })}`);
      if (!panel.el.isConnected) return;
      const t = data.totales;
      panel.body.innerHTML = `
        <p class="crm-notes-empty">Cada pago que entró del ${esc(range.label)}: quién pagó, si es venta nueva, cuota o renovación, y de qué venta viene.</p>
        <div class="dsh-cash-totals">
          <span class="lite-pill green">Total ${esc(money(t.total))}</span>
          <span class="lite-pill">Ventas nuevas ${esc(money(t.venta_nueva))}</span>
          <span class="lite-pill">Cuotas ${esc(money(t.cuota))}</span>
          <span class="lite-pill indigo">Renovaciones ${esc(money(t.renovacion))}</span>
        </div>
        <div class="crm-notes dsh-cash-list">
          ${
            data.pagos.length === 0
              ? '<p class="crm-notes-empty">Sin pagos en este rango.</p>'
              : data.pagos
                  .map(
                    (p) => `
            <div class="client-renewal-item">
              <div class="client-renewal-header">
                <span class="client-renewal-program">${esc(p.cliente)}</span>
                <span class="client-renewal-date">${esc(fmtDate(todayStr(new Date(p.fecha))))}</span>
              </div>
              <div class="client-renewal-meta">
                <span class="dsh-cash-amount">${esc(money(p.monto))}</span>
                <span class="lite-pill${p.tipo === 'renovacion' ? ' indigo' : p.tipo === 'venta_nueva' ? ' orange' : ''}">${esc(TIPO_LABEL[p.tipo] || p.tipo)}</span>
                <span>${esc(attributionOf(p))}</span>
                ${p.metodo ? `<span class="pm-chip">${esc(p.metodo)}</span>` : '<span class="pm-chip is-missing">sin método</span>'}
                ${p.nota ? `<span>${esc(p.nota)}</span>` : ''}
              </div>
            </div>`,
                  )
                  .join('')
          }
        </div>`;
    } catch (err) {
      if (panel.el.isConnected) panel.body.innerHTML = `<div class="reorder-error">${esc(err.message || 'No se pudo cargar el detalle')}</div>`;
    }
  }

  // ---------------------------------------------------------------- Setters / Closers
  function leaderId(rows) {
    let best = null;
    for (const r of rows) if (!best || r.cash > best.cash) best = r;
    return best && best.cash > 0 ? best.id : null;
  }

  function nameCell(r, leader) {
    const label = r.nombre || r.email;
    return `
      <td class="dx-cell-name">
        <span class="dx-person">
          <span class="dx-person-avatar" style="background:${colorOf(r.id)}">${esc(initialsOf(label))}</span>
          <span class="dx-person-name">${esc(label)}</span>
          ${r.id === leader ? `<span class="dx-person-crown" title="Líder en cash del período">${icons.crown}</span>` : ''}
        </span>
      </td>`;
  }

  function summaryHtml(rows, agendasLabel, agendas) {
    const cash = rows.reduce((a, r) => a + r.cash, 0);
    const ventas = rows.reduce((a, r) => a + r.ventas, 0);
    return `
      <div class="dx-team-summary">
        <div class="dx-team-stat dark" style="--i:0">
          <span class="dx-team-stat-label">Cash del equipo</span>
          <span class="dx-team-stat-value">${esc(money(cash))}</span>
          <span class="dx-team-stat-icon">${icons.trend}</span>
        </div>
        <div class="dx-team-stat tone-peach" style="--i:1">
          <span class="dx-team-stat-label">Ventas</span>
          <span class="dx-team-stat-value">${esc(num(ventas))}</span>
          <span class="dx-team-stat-icon">${I.tag}</span>
        </div>
        <div class="dx-team-stat tone-emerald" style="--i:2">
          <span class="dx-team-stat-label">${esc(agendasLabel)}</span>
          <span class="dx-team-stat-value">${esc(num(agendas))}</span>
          <span class="dx-team-stat-icon">${icons.check}</span>
        </div>
      </div>`;
  }

  const orDash = (v) => (v === null || v === undefined ? '—' : num(v, 2));
  const cashPill = (v) => `<span class="dx-cash-pill">${esc(money(v))}</span>`;

  function teamHtml(vista, rows) {
    if (vista === 'setters') {
      const leader = leaderId(rows);
      const head = ['Setter', 'Outbound', 'Resp. outbound', '% Resp.', 'Inbound', 'Nuevas conv.', 'Follow ups', 'Propuestas', 'Links enviados', 'Agendas', 'Calificadas', 'Shows', 'Show up', 'Ventas', 'Close rate', 'Cash collected'];
      return `
        ${rows.length ? summaryHtml(rows, 'Agendas calificadas', rows.reduce((a, r) => a + r.calificadas, 0)) : ''}
        <div class="dx-card dx-table-card">
          <table class="dx-table">
            <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>
              ${
                rows.length === 0
                  ? `<tr><td colspan="${head.length}" class="dx-table-empty">Sin setters activos. Créalos en Equipo → Usuarios.</td></tr>`
                  : rows
                      .map(
                        (r) => `<tr>
                ${nameCell(r, leader)}
                <td>${orDash(r.outbound)}</td>
                <td>${orDash(r.respOutbound)}</td>
                <td>${pct(r.pctRespOutbound)}</td>
                <td>${orDash(r.inbound)}</td>
                <td>${orDash(r.nuevasConversaciones)}</td>
                <td>${orDash(r.followUps)}</td>
                <td>${num(r.propuestas)}</td>
                <td>${num(r.links)}</td>
                <td>${num(r.agendas)}</td>
                <td>${num(r.calificadas)}</td>
                <td>${num(r.shows)}</td>
                <td>${pct(r.showRate)}</td>
                <td>${num(r.ventas)}</td>
                <td>${pct(r.closeRate)}</td>
                <td>${cashPill(r.cash)}</td>
              </tr>`,
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
        <p class="dsh-team-note">Outbound, respuestas, inbound y follow ups salen del EOD de cada setter (suma del rango). Nuevas conversaciones = inbound + respuestas a outbound. El cash no cuenta renovaciones.</p>`;
    }
    const leader = leaderId(rows);
    const head = ['Closer', 'Llamadas', 'Shows', 'Show up', 'Ventas', 'Close rate', 'AOV', 'Facturación', 'Cash collected'];
    return `
      ${rows.length ? summaryHtml(rows, 'Llamadas', rows.reduce((a, r) => a + r.llamadas, 0)) : ''}
      <div class="dx-card dx-table-card">
        <table class="dx-table">
          <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
            ${
              rows.length === 0
                ? `<tr><td colspan="${head.length}" class="dx-table-empty">Sin closers activos. Créalos en Equipo → Usuarios.</td></tr>`
                : rows
                    .map(
                      (r) => `<tr>
              ${nameCell(r, leader)}
              <td>${num(r.llamadas)}</td>
              <td>${num(r.shows)}</td>
              <td>${pct(r.showRate)}</td>
              <td>${num(r.ventas)}</td>
              <td>${pct(r.closeRate)}</td>
              <td>${r.aov === null ? '—' : esc(money(r.aov))}</td>
              <td>${esc(money(r.facturacion))}</td>
              <td>${cashPill(r.cash)}</td>
            </tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
      <p class="dsh-team-note">Llamadas = las que ya debieron ocurrir en el rango, sin canceladas. El cash y la facturación no cuentan renovaciones.</p>`;
  }

  // ---------------------------------------------------------------- arranque
  state.range = rc.current();
  renderHead();
  show();

  return () => {
    state.alive = false;
    clearTimeout(state.prefetchTimer);
  };
}
