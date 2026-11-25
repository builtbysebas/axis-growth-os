// Pantalla: Resultados de contenido (solo admin), con 4 vistas en ?vista=
//  - Resultados (por defecto): embudo y tablas por contenido, ángulo, formato y tipo de story.
//  - Atribución: agendas o ventas del rango con su origen; asignar a mano.
//  - Sin match: avisos de ManyChat cuyo código no coincidió con ningún contenido.
//  - Huecos: contenido sin ángulo, posts sin formato, historias sin tipo.
// Mismo modelo que la versión completa: cada agenda cuenta para su atribución manual o,
// si no tiene, para el último contenido que la lead respondió antes de agendar.
import { get, patch, post, qs } from '../core/api.js';
import { colorOf, debounce, esc, fmtDate, h, icons, initialsOf, money, num, on, pct } from '../core/dom.js';
import { rangeForPreset, rangeLabel } from '../core/dates.js';
import { dxHeader, dxHero, dxSectionLabel, dxSeg, dxTile, dxTiles, emptyState, loading, rangeControls, toast, viewToggle } from '../core/ui.js';

const VIEWS = [
  { key: 'resultados', label: 'Resultados' },
  { key: 'atribucion', label: 'Atribución' },
  { key: 'sinmatch', label: 'Sin match' },
  { key: 'huecos', label: 'Huecos' },
];
const KIND_FILTERS = [
  { key: 'all', label: 'Todo' },
  { key: 'post', label: 'Corto' },
  { key: 'story', label: 'Stories' },
  { key: 'ad', label: 'Ads' },
];
const KIND_LABEL = { post: 'Post', story: 'Historia', ad: 'Anuncio' };
const PLANNER = { post: '/contenido/corto', story: '/contenido/stories', ad: '/contenido/ads' };
const RESULT_LABEL = {
  venta: 'Venta',
  no_show: 'No show',
  no_cerro: 'No cerró',
  cancelada: 'Cancelada',
  reserva: 'Reserva',
  pidio_reagendar: 'Pidió reagendar',
};
const QUICK_MOTIVOS = ['Bienvenida', 'Inbound directo', 'Referido', 'Outbound'];
// Opciones base de los selects de Huecos: las mismas del planificador (pages/contenido.js);
// se suman las que ya existan en el contenido.
const FORMATOS = ['Reel', 'Carrusel animado', 'Carrusel con foto', 'Carrusel caso de éxito', 'Foto', 'Video largo'];
const TIPOS_STORY = ['Poll', 'CTA', 'Q&A', 'Recurso Gratis', 'Encuesta', 'Caja de preguntas', 'Libre'];

const ratio = (a, b) => (b > 0 ? (a / b) * 100 : null);
const roasStr = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(v >= 10 ? 0 : 1)}x`);
const plannerHref = (it) => `${PLANNER[it.kind] || '/contenido/corto'}?item=${encodeURIComponent(it.id)}`;
const normCode = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---------------------------------------------------------------- tabla ordenable
/**
 * cols: [{ key, label, title?, value(row) → número|null, render(row) → html, bar? }]
 * La columna por la que se ordena muestra una barra con su valor.
 */
function sortedRows(rows, cols, sort) {
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  return [...rows].sort((a, b) => {
    const va = col.value(a);
    const vb = col.value(b);
    if (va === null && vb === null) return (b.ventas || 0) - (a.ventas || 0) || (b.leads || 0) - (a.leads || 0);
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * sort.dir || (b.ventas || 0) - (a.ventas || 0) || (b.agendas || 0) - (a.agendas || 0) || (b.leads || 0) - (a.leads || 0);
  });
}

function sortTable({ id, firstLabel, first, rows, cols, sort, limit = 0, expanded = false, empty, cls = '' }) {
  const list = sortedRows(rows, cols, sort);
  const shown = limit && !expanded ? list.slice(0, limit) : list;
  const sortCol = cols.find((c) => c.key === sort.key);
  const max = Math.max(1, ...list.map((r) => Math.abs(Number(sortCol?.value(r)) || 0)));
  const head = cols
    .map(
      (c) => `<th class="num"><button type="button" class="cdb-sort${c.key === sort.key ? ' active' : ''}" data-sort="${id}:${c.key}" ${c.title ? `title="${esc(c.title)}"` : ''} aria-sort="${c.key === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}">${esc(c.label)}<span aria-hidden="true">${c.key === sort.key ? (sort.dir === 1 ? '↑' : '↓') : ''}</span></button></th>`,
    )
    .join('');
  const body = shown.length
    ? shown
        .map(
          (r) => `<tr>
            <td class="dx-cell-name">${first(r)}</td>
            ${cols
              .map((c) => {
                const inner = c.render(r);
                if (c.key !== sort.key || c.bar === false) return `<td class="num">${inner}</td>`;
                const v = Math.abs(Number(c.value(r)) || 0);
                return `<td class="num"><span class="cdb-inline-bar"><i style="width:${((v / max) * 100).toFixed(1)}%"></i><b>${inner}</b></span></td>`;
              })
              .join('')}
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="${cols.length + 1}" class="dx-table-empty">${esc(empty)}</td></tr>`;
  return `
    <div class="dx-card dx-table-card ${cls}">
      <div class="cdb-table-scroll">
        <table class="dx-table cdb-table">
          <thead><tr><th>${esc(firstLabel)}</th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${limit && list.length > limit ? `<button type="button" class="cdb-more" data-more="${id}">${expanded ? 'Ver menos' : `Ver las ${list.length}`}</button>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- buscador de contenido
/** Buscador (mismo look que RelationPicker de la versión completa), con la lista dentro del flujo. */
function contentPicker({ onSelect, onEscape, placeholder = 'Buscar por código o título…' }) {
  const el = h(`
    <div class="relation-picker res-picker">
      <div class="relation-picker-popover">
        <input type="text" placeholder="${esc(placeholder)}" aria-label="Buscar contenido">
        <div class="relation-picker-options" role="listbox"><p class="relation-picker-empty">Buscando…</p></div>
      </div>
    </div>`);
  const input = el.querySelector('input');
  const list = el.querySelector('.relation-picker-options');
  let items = [];
  let ctrl;
  async function search(q) {
    ctrl?.abort();
    ctrl = new AbortController();
    list.innerHTML = '<p class="relation-picker-empty">Buscando…</p>';
    try {
      const r = await get(`/contenido/buscar${qs({ q })}`, { signal: ctrl.signal });
      items = r.items || [];
      list.innerHTML = items.length
        ? items
            .map(
              (c, i) => `<button type="button" class="relation-picker-option" role="option" data-pick="${i}">
                  <span class="relation-picker-option-label">${esc(c.codigo || c.titulo)}</span>
                  <span class="relation-picker-option-sub">${esc([KIND_LABEL[c.kind] || c.kind, c.titulo, fmtDate(c.fecha)].filter(Boolean).join(' · '))}</span>
                </button>`,
            )
            .join('')
        : `<p class="relation-picker-empty">${q ? 'Nada coincide con esa búsqueda.' : 'Todavía no hay contenido cargado.'}</p>`;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      list.innerHTML = `<p class="relation-picker-empty">${esc(err.message || 'No se pudo buscar')}</p>`;
    }
  }
  const later = debounce((q) => search(q), 250);
  input.addEventListener('input', () => later(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onEscape?.();
    if (e.key === 'Enter' && items.length) {
      e.preventDefault();
      onSelect(items[0]);
    }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) onSelect(items[Number(b.dataset.pick)]);
  });
  search('');
  requestAnimationFrame(() => input.focus());
  return el;
}

// ---------------------------------------------------------------- pantalla
export async function render(root, ctx) {
  const initial = rangeForPreset('month');
  const st = {
    view: VIEWS.some((v) => v.key === ctx.params.get('vista')) ? ctx.params.get('vista') : 'resultados',
    preset: 'month',
    customFrom: '',
    customTo: '',
    range: { ...initial, label: rangeLabel(initial) },
    // Resultados
    kind: 'all',
    res: null,
    sorts: { piezas: { key: 'ventas', dir: -1 }, angulo: { key: 'ventas', dir: -1 }, formato: { key: 'ventas', dir: -1 }, tipo: { key: 'ventas', dir: -1 } },
    expanded: {},
    // Atribución
    scope: 'agendas',
    onlyNone: false,
    atr: null,
    editing: null,
    // Sin match
    events: null,
    assigning: null,
    // Huecos
    gap: 'angulo',
    gapKind: 'all',
    onlyWithLeads: true,
    gaps: null,
  };
  let ctrl = null;
  let controls = null;
  let busy = false;

  const page = h('<div class="crm-page dx-page res-page"><div data-head></div><div data-controls></div><div data-body></div></div>');
  root.appendChild(page);
  const headEl = page.querySelector('[data-head]');
  const controlsEl = page.querySelector('[data-controls]');
  const bodyEl = page.querySelector('[data-body]');

  const TITLES = { resultados: 'Resultados', sinmatch: 'Sin match', huecos: 'Huecos de contenido' };
  function renderHead() {
    const title = st.view === 'atribucion' ? (st.scope === 'ventas' ? 'Atribución de ventas' : 'Atribución de agendas') : TITLES[st.view];
    const withRange = st.view === 'resultados' || st.view === 'atribucion';
    headEl.innerHTML = dxHeader({
      eyebrow: 'Contenido',
      title,
      rangeText: withRange ? st.range.label : '',
      actionsHtml: viewToggle(VIEWS, st.view, 'Vistas de Resultados Contenido'),
    });
  }

  function mountControls() {
    controlsEl.innerHTML = '';
    controls = null;
    if (st.view === 'resultados' || st.view === 'atribucion') {
      const lead =
        st.view === 'resultados'
          ? dxSeg(KIND_FILTERS, st.kind, { label: 'Tipo de contenido', name: 'kind' })
          : `${dxSeg(
              [
                { key: 'agendas', label: 'Agendas' },
                { key: 'ventas', label: 'Ventas' },
              ],
              st.scope,
              { soft: true, label: 'Qué atribuir', name: 'scope' },
            )}${dxSeg(
              [
                { key: 'all', label: 'Todas' },
                { key: 'none', label: `Solo sin atribución${st.atr?.counts.ninguna ? ` (${st.atr.counts.ninguna})` : ''}` },
              ],
              st.onlyNone ? 'none' : 'all',
              { soft: true, label: 'Filtro de atribución', name: 'onlynone' },
            )}`;
      controls = rangeControls({
        preset: st.preset,
        from: st.customFrom,
        to: st.customTo,
        leadHtml: lead,
        onChange: (r) => {
          st.preset = r.preset;
          if (r.preset === 'custom') {
            st.customFrom = r.from;
            st.customTo = r.to;
          }
          st.range = { from: r.from, to: r.to, label: r.label };
          st.editing = null;
          renderHead();
          load();
        },
      });
      controlsEl.appendChild(controls.el);
    } else if (st.view === 'huecos') {
      controlsEl.innerHTML = `<div class="dx-controls">
        ${dxSeg(
          [
            { key: 'angulo', label: 'Sin ángulo' },
            { key: 'formato', label: 'Posts sin formato' },
            { key: 'tipo', label: 'Historias sin tipo' },
          ],
          st.gap,
          { soft: true, label: 'Hueco a cerrar', name: 'gap' },
        )}
        ${st.gap === 'angulo' ? dxSeg(KIND_FILTERS, st.gapKind, { soft: true, label: 'Tipo', name: 'gapkind' }) : ''}
        ${dxSeg(
          [
            { key: 'leads', label: 'Solo con leads' },
            { key: 'all', label: 'Todos' },
          ],
          st.onlyWithLeads ? 'leads' : 'all',
          { soft: true, label: 'Con leads', name: 'withleads' },
        )}
      </div>`;
    }
  }

  function setBusy(v) {
    busy = v;
    controls?.setBusy(v);
    bodyEl.classList.toggle('cdb-stale', v && !!bodyEl.firstElementChild && !bodyEl.querySelector('.lite-loading'));
  }

  async function load() {
    ctrl?.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    const view = st.view;
    const hasData = (view === 'resultados' && st.res) || (view === 'atribucion' && st.atr) || (view === 'sinmatch' && st.events) || (view === 'huecos' && st.gaps);
    if (!hasData) bodyEl.innerHTML = loading();
    setBusy(true);
    try {
      if (view === 'resultados') {
        st.res = await get(`/resultados${qs({ from: st.range.from, to: st.range.to, kind: st.kind === 'all' ? '' : st.kind })}`, { signal });
      } else if (view === 'atribucion') {
        st.atr = await get(
          `/resultados/atribucion${qs({ scope: st.scope, from: st.range.from, to: st.range.to, sinAtribucion: st.onlyNone ? '1' : '' })}`,
          { signal },
        );
        // el contador de «Solo sin atribución» vive en el control
        const none = controlsEl.querySelector('[data-seg-name="onlynone"] [data-seg="none"]');
        if (none) none.textContent = `Solo sin atribución${st.atr.counts.ninguna ? ` (${st.atr.counts.ninguna})` : ''}`;
      } else if (view === 'sinmatch') {
        st.events = (await get('/events?sinMatch=1', { signal })).events || [];
      } else {
        st.gaps = await get('/resultados/huecos', { signal });
      }
      if (view !== st.view) return;
      setBusy(false);
      renderBody();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setBusy(false);
      if (!hasData) bodyEl.innerHTML = emptyState(err.message || 'No se pudo cargar. Vuelve a intentar.');
      else toast(err.message || 'No se pudo actualizar', { error: true });
    }
  }

  function renderBody() {
    if (st.view === 'resultados') bodyEl.innerHTML = st.res ? resultadosHtml() : loading();
    else if (st.view === 'atribucion') {
      bodyEl.innerHTML = st.atr ? atribucionHtml() : loading();
      mountEditorPicker();
    } else if (st.view === 'sinmatch') {
      bodyEl.innerHTML = st.events ? sinMatchHtml() : loading();
      mountAssignPicker();
    } else bodyEl.innerHTML = st.gaps ? huecosHtml() : loading();
  }

  function showView() {
    renderHead();
    mountControls();
    bodyEl.classList.remove('cdb-stale');
    renderBody();
    load();
  }

  // ================================================================ RESULTADOS
  function pieceCell(it) {
    return `<span class="cdb-piece">
      <span class="cdb-piece-text">
        <a class="cdb-piece-title res-link" href="${esc(plannerHref(it))}" data-link title="Abrir en su planificador">${esc(it.titulo || it.codigo)}</a>
        <span class="cdb-piece-meta">
          <span class="cdb-kind kind-${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span>
          ${it.fecha ? `<span>${esc(fmtDate(it.fecha, { year: false }))}</span>` : ''}
          ${it.anguloNombre ? `<span class="cdb-angle">${esc(it.anguloNombre)}</span>` : ''}
          <span class="res-code-inline">${esc(it.codigo)}</span>
        </span>
      </span>
    </span>`;
  }

  function funnelCols(isAds) {
    const cols = [
      { key: 'leads', label: 'Leads', title: 'Personas distintas que respondieron', value: (r) => r.leads, render: (r) => `<b>${num(r.leads)}</b>` },
      { key: 'agendas', label: 'Agendas', value: (r) => r.agendas, render: (r) => num(r.agendas) },
      { key: 'shows', label: 'Shows', value: (r) => r.shows, render: (r) => num(r.shows) },
      { key: 'ventas', label: 'Ventas', value: (r) => r.ventas, render: (r) => `<b>${num(r.ventas)}</b>` },
      { key: 'cash', label: 'Cash', value: (r) => r.cash, render: (r) => (r.cash > 0 ? `<span class="dx-cash-pill">${money(r.cash)}</span>` : '—') },
    ];
    if (isAds) {
      cols.push(
        { key: 'gasto', label: 'Gasto', value: (r) => (r.gasto ? r.gasto : null), render: (r) => (r.gasto ? money(r.gasto) : '—') },
        {
          key: 'cpl',
          label: 'Costo/lead',
          value: (r) => (r.gasto && r.leads ? r.gasto / r.leads : null),
          render: (r) => (r.gasto && r.leads ? money(Math.round((r.gasto / r.leads) * 100) / 100) : '—'),
        },
        { key: 'roas', label: 'ROAS', title: 'Cash ÷ gasto', value: (r) => (r.gasto ? r.cash / r.gasto : null), render: (r) => (r.gasto ? roasStr(r.cash / r.gasto) : '—') },
      );
    }
    return cols;
  }

  function rollup(items, keyOf, labelOf) {
    const map = new Map();
    for (const it of items) {
      const key = keyOf(it);
      let g = map.get(key);
      if (!g) {
        g = { key, label: labelOf(it), piezas: 0, leads: 0, agendas: 0, shows: 0, ventas: 0, cash: 0, gasto: 0 };
        map.set(key, g);
      }
      g.piezas++;
      for (const k of ['leads', 'agendas', 'shows', 'ventas', 'cash']) g[k] += it[k] || 0;
      g.gasto += it.gasto || 0;
    }
    return [...map.values()];
  }

  function groupTable(id, title, firstLabel, groups, isAds) {
    const cols = [{ key: 'piezas', label: 'Piezas', value: (r) => r.piezas, render: (r) => num(r.piezas) }, ...funnelCols(isAds)];
    return `<div class="cdb-col">
      ${dxSectionLabel(title)}
      ${sortTable({ id, firstLabel, first: (g) => `<span class="dx-person-name">${esc(g.label)}</span>`, rows: groups, cols, sort: st.sorts[id], empty: 'Sin datos en este rango.' })}
    </div>`;
  }

  function resultadosHtml() {
    const d = st.res;
    const t = d.totals;
    const isAds = d.kind === 'ad';
    const items = d.items;
    if (!items.length) {
      return `<div class="dx-card res-empty-card">${emptyState(
        'No hay contenido con fecha en este rango. Los resultados se cuentan por la fecha del contenido (aunque la venta cierre semanas después).',
      )}</div>${antesHtml()}`;
    }
    const sinPct = ratio(t.sinPresupuesto, t.agendas);
    const showRate = ratio(t.shows, t.llamadas);
    const closeRate = t.shows ? Math.min(100, ratio(t.ventas, t.shows)) : null;
    let i = 0;
    const tiles = [
      dxTile({ index: i++, icon: icons.doc, tone: 'peach', label: 'Piezas', value: num(t.piezas), sub: 'con fecha en el rango' }),
      dxTile({ index: i++, icon: icons.chat, tone: 'indigo', label: 'Leads', value: num(t.leads), sub: `${num(t.leadsPersonas)} persona(s) distintas` }),
      dxTile({ index: i++, icon: icons.calendar, tone: 'peach', label: 'Agendas', value: num(t.agendas), sub: `${pct(ratio(t.agendas, t.leads), 1)} de los leads · ${num(t.canceladas)} cancelada(s)` }),
      dxTile({ index: i++, icon: icons.money, tone: 'peach', label: 'Sin presupuesto', value: pct(sinPct), sub: `${num(t.sinPresupuesto)} de ${num(t.agendas)} agendas` }),
      dxTile({ index: i++, icon: icons.users, tone: 'indigo', label: 'Shows', value: num(t.shows), sub: `show rate ${pct(showRate)} · ${num(t.noShows)} no show` }),
      dxTile({ index: i++, icon: icons.check, tone: 'emerald', label: 'Ventas', value: num(t.ventas), sub: `close rate ${pct(closeRate)}` }),
    ];
    if (isAds) {
      tiles.push(
        dxTile({ index: i++, icon: icons.chart, tone: 'peach', label: 'Gasto', value: money(t.gasto), sub: 'cargado en cada anuncio' }),
        dxTile({ index: i++, icon: icons.target, tone: 'indigo', label: 'Costo por lead', value: t.costoPorLead === null ? '—' : money(Math.round(t.costoPorLead * 100) / 100), sub: t.agendas ? `${money(Math.round((t.gasto / t.agendas) * 100) / 100)} por agenda` : 'sin agendas' }),
        dxTile({ index: i++, icon: icons.trend, tone: 'emerald', label: 'ROAS', value: roasStr(t.roas), sub: 'cash ÷ gasto' }),
      );
    }
    const steps = [
      { label: 'Leads', value: t.leads, rate: null },
      { label: 'Agendas', value: t.agendas, rate: ratio(t.agendas, t.leads), rateLabel: 'de los leads' },
      { label: 'Shows', value: t.shows, rate: showRate, rateLabel: 'de las llamadas', hint: 'Sin contar canceladas ni llamadas que todavía no ocurren' },
      { label: 'Ventas', value: t.ventas, rate: closeRate, rateLabel: 'de los shows' },
    ];
    const funnel = `<ol class="cdb-funnel">${steps
      .map(
        (s, k) => `<li style="--i:${k}">
          <span class="cdb-funnel-label">${esc(s.label)}</span>
          <strong class="cdb-funnel-value">${num(s.value)}</strong>
          ${k > 0 ? `<span class="cdb-funnel-rate" ${s.hint ? `title="${esc(s.hint)}"` : ''}>${pct(s.rate, s.rate !== null && s.rate < 10 ? 1 : 0)} <em>${esc(s.rateLabel)}</em></span>` : ''}
        </li>`,
      )
      .join('')}</ol>`;

    const pieceCols = [
      { key: 'fecha', label: 'Fecha', value: (r) => (r.fecha ? Date.parse(r.fecha) : null), render: (r) => (r.fecha ? esc(fmtDate(r.fecha, { year: false })) : '—'), bar: false },
      ...funnelCols(isAds),
    ];
    const piezas = sortTable({
      id: 'piezas',
      firstLabel: 'Contenido',
      first: pieceCell,
      rows: items,
      cols: pieceCols,
      sort: st.sorts.piezas,
      limit: 25,
      expanded: !!st.expanded.piezas,
      empty: 'Sin contenido en este rango.',
      cls: 'res-pieces',
    });

    const byAngle = rollup(items, (it) => it.anguloId || '__none', (it) => it.anguloNombre || 'Sin ángulo');
    const posts = items.filter((it) => it.kind === 'post');
    const stories = items.filter((it) => it.kind === 'story');
    const byFormat = rollup(posts, (it) => it.formato || '__none', (it) => it.formato || 'Sin formato');
    const byTipo = rollup(stories, (it) => it.tipoStory || '__none', (it) => it.tipoStory || 'Sin tipo');
    const side = [];
    if (d.kind === 'all' || d.kind === 'post') side.push(groupTable('formato', 'Por formato (posts)', 'Formato', byFormat, false));
    if (d.kind === 'all' || d.kind === 'story') side.push(groupTable('tipo', 'Por tipo de story', 'Tipo', byTipo, false));

    return `
      ${dxHero({
        label: isAds ? 'Cash de los anuncios' : 'Cash generado por el contenido',
        value: money(t.cash),
        noteHtml: esc(
          `${num(t.ventas)} venta(s) de ${num(t.piezas)} pieza(s)${isAds && t.roas !== null ? ` · ROAS ${roasStr(t.roas)} sobre ${money(t.gasto)} de gasto` : ''} · sin renovaciones`,
        ),
      })}
      <div class="res-gap"></div>
      ${dxTiles(tiles.join(''))}
      <div class="cdb-section">
        ${dxSectionLabel('Del lead a la venta · contenido con fecha en el rango')}
        <div class="dx-card cdb-funnel-card">
          ${funnel}
          <p class="cdb-foot">Canceladas: <b>${num(t.canceladas)}</b> (no califican: no cuentan como show ni como no show). Cada agenda cuenta para su atribución manual o, si no tiene, para el último contenido que la lead respondió antes de agendar. Las ventas y el cash pueden llegar semanas después de publicado.</p>
        </div>
      </div>
      <div class="cdb-section">
        ${dxSectionLabel('Pieza por pieza')}
        ${piezas}
      </div>
      <div class="cdb-grid2 cdb-section">
        ${groupTable('angulo', 'Por ángulo', 'Ángulo', byAngle, isAds)}
        ${side.join('')}
      </div>
      ${antesHtml()}`;
  }

  function antesHtml() {
    const a = st.res?.antesDeComprar;
    if (!a) return '';
    return `<p class="cdb-foot cdb-foot-page">Contenidos antes de comprar: <b>${a.promedio === null ? '—' : a.promedio.toFixed(1)}</b> en promedio (${num(a.ventas)} venta(s) con contacto de ManyChat, todo el historial): cuántos contenidos distintos respondió cada comprador antes de su primer pago.</p>`;
  }

  // ================================================================ ATRIBUCIÓN
  function originBadge(r) {
    if (r.origen === 'auto') return '<span class="dxc-badge dxc-badge-auto">Automático</span>';
    if (r.origen === 'ninguna') return '<span class="dxc-badge dxc-badge-none">Sin atribución</span>';
    return '<span class="dxc-badge dxc-badge-manual">Manual</span>';
  }
  function attributionCell(r) {
    if (r.origen === 'manual_motivo') return `<span class="res-motivo">${esc(r.motivo)}</span>`;
    if (r.contenido) {
      if (!r.contenido.existe) return '<span class="res-muted">(contenido borrado)</span>';
      return `<a class="res-link" href="${esc(plannerHref(r.contenido))}" data-link><span class="dxc-title">${esc(r.contenido.codigo)}</span></a><span class="dxc-code">${esc(r.contenido.titulo)}</span>`;
    }
    return '<span class="res-muted">—</span>';
  }

  function atribucionHtml() {
    const d = st.atr;
    const isVentas = d.scope === 'ventas';
    const noun = isVentas ? 'ventas' : 'agendas';
    const c = d.counts;
    const tiles = dxTiles(
      [
        dxTile({ index: 0, icon: icons.doc, tone: 'peach', label: isVentas ? 'Ventas totales' : 'Agendas totales', value: num(c.total), sub: isVentas ? `${money(c.ticket)} en tickets · ${money(c.cash)} cobrado` : 'en este rango' }),
        dxTile({ index: 1, icon: icons.link, tone: 'indigo', label: 'Automáticas', value: num(c.auto), sub: 'último contenido antes de agendar' }),
        dxTile({ index: 2, icon: icons.check, tone: 'emerald', label: 'Manuales', value: num(c.manual), sub: 'asignadas a mano' }),
        dxTile({ index: 3, icon: icons.target, tone: 'peach', label: 'Sin atribución', value: num(c.ninguna), sub: 'por asignar' }),
      ].join(''),
    );
    const colspan = isVentas ? 10 : 8;
    const rows = d.rows
      .map((r) => {
        const open = st.editing === r.id;
        return `<tr>
          <td>${esc(fmtDate(r.fecha))}</td>
          <td class="dx-cell-name"><span class="dx-person"><span class="dx-person-avatar" style="background:${colorOf(r.id)}">${esc(initialsOf(r.nombre))}</span><span class="dx-person-name">${esc(r.nombre)}</span></span></td>
          <td>${esc(r.setter || '—')}</td>
          <td>${esc(r.closer || '—')}</td>
          ${
            isVentas
              ? `<td>${money(r.montoTotal)}</td><td>${r.pagoInicial ? money(r.pagoInicial) : '—'}</td><td><span class="dx-cash-pill">${money(r.cash)}</span></td>`
              : `<td>${r.resultado ? esc(RESULT_LABEL[r.resultado] || r.resultado) : r.cancelada ? 'Cancelada' : '<span class="res-muted">Sin resultado</span>'}${r.resultado === 'venta' && r.montoTotal ? ` · ${money(r.montoTotal)}` : ''}</td>`
          }
          <td class="res-wrap">${attributionCell(r)}</td>
          <td>${originBadge(r)}</td>
          <td><button type="button" class="dxc-action" data-edit="${esc(r.id)}" aria-expanded="${open}">${open ? 'Cerrar' : 'Asignar'}</button></td>
        </tr>
        ${open ? editorRowHtml(r, colspan) : ''}`;
      })
      .join('');
    return `
      ${tiles}
      <div class="res-gap-lg"></div>
      <div class="dx-card dx-table-card">
        <table class="dx-table res-attr-table">
          <thead><tr>
            <th>${isVentas ? 'Fecha de venta' : 'Agendada'}</th><th>Lead</th><th>Setter</th><th>Closer</th>
            ${isVentas ? '<th>Ticket</th><th>Upfront</th><th>Cash cobrado</th>' : '<th>Resultado</th>'}
            <th>Atribución</th><th>Origen</th><th></th>
          </tr></thead>
          <tbody>${
            rows ||
            `<tr><td colspan="${colspan}" class="dx-table-empty">${st.onlyNone ? `Todas las ${noun} de este rango tienen atribución.` : `No hay ${noun} en este rango.`}</td></tr>`
          }</tbody>
        </table>
      </div>
      <p class="cdb-foot">Automático = el último contenido que la lead respondió (ManyChat) antes de agendar. Una atribución manual siempre gana. Atribuir una agenda también atribuye su venta.</p>`;
  }

  function editorRowHtml(r, colspan) {
    const hasManual = r.origen === 'manual_contenido' || r.origen === 'manual_motivo';
    return `<tr class="sales-attribution-editor-row res-editor-row"><td colspan="${colspan}">
      <div class="sales-attribution-editor res-editor">
        <div class="res-editor-block">
          <span class="crm-field-label">Elegir un contenido o anuncio</span>
          <div data-picker-slot></div>
        </div>
        <div class="sales-attribution-editor-or">o</div>
        <div class="res-editor-block">
          <span class="crm-field-label">Motivo sin contenido</span>
          <div class="sales-attribution-editor-quick-row">
            ${QUICK_MOTIVOS.map((m) => `<button type="button" class="crm-chip crm-chip-plain${r.origen === 'manual_motivo' && r.motivo === m ? ' active' : ''}" data-motivo="${esc(m)}">${esc(m)}</button>`).join('')}
          </div>
          <form class="sales-attribution-editor-label-row" data-motivo-form>
            <input type="text" name="motivo" maxlength="200" placeholder="Otro motivo…" value="${r.origen === 'manual_motivo' && !QUICK_MOTIVOS.includes(r.motivo) ? esc(r.motivo) : ''}" aria-label="Otro motivo">
            <button type="submit" class="btn-secondary btn-sm">Guardar</button>
          </form>
        </div>
        <div class="sales-attribution-editor-actions">
          ${hasManual ? '<button type="button" class="btn-ghost sales-attribution-clear-btn" data-clear>Quitar atribución manual</button>' : ''}
          <button type="button" class="btn-secondary btn-sm" data-edit-close>Cerrar</button>
        </div>
      </div>
    </td></tr>`;
  }

  function mountEditorPicker() {
    const slot = bodyEl.querySelector('[data-picker-slot]');
    if (!slot || !st.editing) return;
    const id = st.editing;
    slot.appendChild(
      contentPicker({
        onSelect: (c) => saveAttribution(id, { contenidoId: c.id }, `Asignada a ${c.codigo || c.titulo}`),
        onEscape: () => {
          st.editing = null;
          renderBody();
        },
      }),
    );
  }

  async function saveAttribution(id, body, okText) {
    if (busy) return;
    setBusy(true);
    try {
      await patch(`/ventas/${encodeURIComponent(id)}/atribucion`, body);
      toast(okText);
      st.editing = null;
      setBusy(false);
      await load();
    } catch (err) {
      setBusy(false);
      toast(err.message || 'No se pudo guardar la atribución', { error: true });
    }
  }

  // ================================================================ SIN MATCH
  function eventGroups() {
    const map = new Map();
    for (const e of st.events || []) {
      const key = normCode(e.codigo) || '(sin código)';
      let g = map.get(key);
      if (!g) {
        g = { key, codigo: e.codigo || '(sin código)', events: [], ultimo: e.recibido };
        map.set(key, g);
      }
      g.events.push(e);
      if (e.recibido > g.ultimo) g.ultimo = e.recibido;
    }
    return [...map.values()].sort((a, b) => b.events.length - a.events.length || String(b.ultimo).localeCompare(String(a.ultimo)));
  }

  function sinMatchHtml() {
    const groups = eventGroups();
    const total = (st.events || []).length;
    const tiles = dxTiles(
      [
        dxTile({ index: 0, icon: icons.chat, tone: 'peach', label: 'Avisos sin match', value: num(total), sub: total >= 200 ? 'se muestran los 200 más recientes' : 'respuestas a contenido sin código conocido' }),
        dxTile({ index: 1, icon: icons.doc, tone: 'indigo', label: 'Códigos distintos', value: num(groups.length), sub: 'cada uno se asigna una vez' }),
        dxTile({ index: 2, icon: icons.users, tone: 'emerald', label: 'Leads', value: num(new Set((st.events || []).map((e) => e.contact_id)).size), sub: 'contactos distintos' }),
      ].join(''),
    );
    if (!groups.length) {
      return `${tiles}<div class="res-gap-lg"></div><div class="dx-card">${emptyState('Todo lo que llegó de ManyChat coincidió con un contenido. No hay nada para asignar.')}</div>`;
    }
    const rows = groups
      .map((g) => {
        const open = st.assigning === g.key;
        const names = [...new Set(g.events.map((e) => e.nombre || (e.usuario_ig ? `@${e.usuario_ig}` : e.contact_id)).filter(Boolean))];
        return `<tr>
          <td class="dx-cell-name"><code class="dxc-mono res-code">${esc(g.codigo)}</code></td>
          <td class="num"><b>${num(g.events.length)}</b></td>
          <td class="res-wrap">${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` <span class="res-muted">y ${names.length - 3} más</span>` : ''}</td>
          <td>${esc(fmtDate(g.ultimo))}</td>
          <td><button type="button" class="dxc-action" data-assign="${esc(g.key)}" aria-expanded="${open}">${open ? 'Cerrar' : g.events.length > 1 ? `Asignar los ${g.events.length}` : 'Asignar'}</button></td>
        </tr>
        ${
          open
            ? `<tr class="sales-attribution-editor-row res-editor-row"><td colspan="5"><div class="sales-attribution-editor res-editor">
                <div class="res-editor-block"><span class="crm-field-label">¿A qué contenido corresponde «${esc(g.codigo)}»?</span><div data-assign-slot></div></div>
                <div class="sales-attribution-editor-actions"><button type="button" class="btn-secondary btn-sm" data-assign-close>Cerrar</button></div>
              </div></td></tr>`
            : ''
        }`;
      })
      .join('');
    return `
      ${tiles}
      <div class="res-gap-lg"></div>
      <div class="dx-card dx-table-card">
        <table class="dx-table">
          <thead><tr><th>Código que mandó ManyChat</th><th class="num">Avisos</th><th>Leads</th><th>Último</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="cdb-foot">Llegan acá cuando el código de la automatización de ManyChat no coincide con ningún contenido (por ejemplo, un error al copiarlo o un contenido cargado después). Ningún lead se pierde: al asignarlo, cuenta para ese contenido. Si el código está mal escrito en ManyChat, corrígelo allá para que los próximos lleguen solos.</p>`;
  }

  function mountAssignPicker() {
    const slot = bodyEl.querySelector('[data-assign-slot]');
    if (!slot || !st.assigning) return;
    const g = eventGroups().find((x) => x.key === st.assigning);
    if (!g) return;
    slot.appendChild(
      contentPicker({
        onSelect: (c) => assignGroup(g, c),
        onEscape: () => {
          st.assigning = null;
          renderBody();
        },
      }),
    );
  }

  async function assignGroup(g, c) {
    if (busy) return;
    setBusy(true);
    let ok = 0;
    let fail = null;
    try {
      const r = await post('/events/match', { ids: g.events.map((e) => e.id), contenidoId: c.id });
      ok = r.actualizados;
    } catch (err) {
      fail = err;
    }
    setBusy(false);
    if (ok) toast(`${ok} aviso(s) asignado(s) a ${c.codigo || c.titulo}`);
    if (fail) toast(fail.message || 'No se pudo asignar', { error: true });
    st.assigning = null;
    await load();
  }

  // ================================================================ HUECOS
  function gapOf(it) {
    if (st.gap === 'angulo') return !it.anguloId;
    if (st.gap === 'formato') return it.kind === 'post' && !it.formato;
    return it.kind === 'story' && !it.tipoStory;
  }

  function huecosHtml() {
    const d = st.gaps;
    const label = st.gap === 'angulo' ? 'ángulo' : st.gap === 'formato' ? 'formato' : 'tipo de story';
    const kindFilter = st.gap === 'angulo' ? st.gapKind : st.gap === 'formato' ? 'post' : 'story';
    const missing = d.items.filter(gapOf).filter((it) => kindFilter === 'all' || it.kind === kindFilter);
    const visible = missing.filter((it) => !st.onlyWithLeads || it.leads > 0);
    const totalLeads = kindFilter === 'all' ? d.totalLeads : d.leadsPorKind[kindFilter] || 0;
    const missingLeads = missing.reduce((a, it) => a + it.leads, 0);
    const missingAgendas = missing.reduce((a, it) => a + it.agendas, 0);
    const covered = totalLeads > 0 ? Math.round(((totalLeads - missingLeads) / totalLeads) * 100) : 100;
    const tiles = dxTiles(
      [
        dxTile({ index: 0, icon: icons.target, tone: 'peach', label: `Sin ${label}`, value: num(missing.length), sub: `${num(missing.filter((it) => it.leads > 0).length)} con leads` }),
        dxTile({ index: 1, icon: icons.users, tone: 'indigo', label: 'Leads sin cubrir', value: num(missingLeads), sub: `de ${num(totalLeads)} en total` }),
        dxTile({ index: 2, icon: icons.calendar, tone: 'peach', label: 'Agendas sin cubrir', value: num(missingAgendas), sub: 'atribuidas a estos contenidos' }),
        dxTile({ index: 3, icon: icons.check, tone: 'emerald', label: 'Cobertura de leads', value: `${covered}%`, sub: `con ${label} asignado` }),
      ].join(''),
    );
    let options;
    if (st.gap === 'angulo') options = d.angulos.map((a) => ({ value: a.id, label: a.nombre }));
    else {
      const base = st.gap === 'formato' ? FORMATOS : TIPOS_STORY;
      const extra = st.gap === 'formato' ? d.formatos : d.tiposStory;
      options = [...new Set([...base, ...extra])].map((v) => ({ value: v, label: v }));
    }
    const maxLeads = Math.max(1, ...visible.map((it) => it.leads));
    const rows = visible
      .map(
        (it) => `<tr>
          <td class="dx-cell-name res-wrap"><a class="res-link" href="${esc(plannerHref(it))}" data-link><span class="dxc-title">${esc(it.titulo || it.codigo)}</span></a><span class="dxc-code">${esc(it.codigo)}</span></td>
          <td><span class="cdb-kind kind-${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span></td>
          <td>${it.fecha ? esc(fmtDate(it.fecha, { year: false })) : '—'}</td>
          <td class="num"><span class="cdb-inline-bar"><i style="width:${((it.leads / maxLeads) * 100).toFixed(1)}%"></i><b>${num(it.leads)}</b></span></td>
          <td class="num">${num(it.agendas)}</td>
          <td>
            <select class="res-select" data-gap-select="${esc(it.id)}" aria-label="Elegir ${esc(label)}">
              <option value="">— Elegir ${esc(label)} —</option>
              ${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
            </select>
          </td>
        </tr>`,
      )
      .join('');
    const noAngles = st.gap === 'angulo' && !d.angulos.length;
    return `
      ${tiles}
      <div class="res-gap-lg"></div>
      ${noAngles ? `<p class="res-warn">Todavía no hay ángulos creados. Créalos en <a class="res-link" href="/contenido/recursos" data-link>Recursos y Ángulos</a> para poder asignarlos.</p>` : ''}
      <div class="dx-card dx-table-card">
        <table class="dx-table">
          <thead><tr><th>Contenido</th><th>Tipo</th><th>Fecha</th><th class="num">Leads</th><th class="num">Agendas</th><th>${esc(label.charAt(0).toUpperCase() + label.slice(1))}</th></tr></thead>
          <tbody>${
            rows ||
            `<tr><td colspan="6" class="dx-table-empty">${missing.length ? 'No hay contenidos con este filtro.' : `Todos los contenidos tienen ${esc(label)}.`}</td></tr>`
          }</tbody>
        </table>
      </div>`;
  }

  async function assignGap(sel) {
    const id = sel.dataset.gapSelect;
    const value = sel.value;
    if (!value) return;
    const field = st.gap === 'angulo' ? 'angulo_id' : st.gap === 'formato' ? 'formato' : 'tipo_story';
    sel.disabled = true;
    try {
      await patch(`/contenido/${encodeURIComponent(id)}`, { [field]: value });
      const it = st.gaps.items.find((x) => x.id === id);
      if (it) {
        if (field === 'angulo_id') it.anguloId = value;
        else if (field === 'formato') it.formato = value;
        else it.tipoStory = value;
      }
      toast('Guardado');
      renderBody();
    } catch (err) {
      sel.disabled = false;
      sel.value = '';
      toast(err.message || 'No se pudo guardar', { error: true });
    }
  }

  // ================================================================ eventos
  const offs = [
    on(page, 'click', '.crm-view-toggle [data-view]', (e, b) => {
      const v = b.dataset.view;
      if (v === st.view) return;
      st.view = v;
      st.editing = null;
      st.assigning = null;
      ctx.setParams({ vista: v === 'resultados' ? null : v });
      showView();
    }),
    on(page, 'click', '[data-seg-name="kind"] [data-seg]', (e, b) => {
      if (b.dataset.seg === st.kind) return;
      st.kind = b.dataset.seg;
      mountControls();
      load();
    }),
    on(page, 'click', '[data-seg-name="scope"] [data-seg]', (e, b) => {
      if (b.dataset.seg === st.scope) return;
      st.scope = b.dataset.seg;
      st.editing = null;
      st.atr = null;
      renderHead();
      mountControls();
      renderBody();
      load();
    }),
    on(page, 'click', '[data-seg-name="onlynone"] [data-seg]', (e, b) => {
      const v = b.dataset.seg === 'none';
      if (v === st.onlyNone) return;
      st.onlyNone = v;
      st.editing = null;
      mountControls();
      load();
    }),
    on(page, 'click', '[data-seg-name="gap"] [data-seg]', (e, b) => {
      st.gap = b.dataset.seg;
      mountControls();
      renderBody();
    }),
    on(page, 'click', '[data-seg-name="gapkind"] [data-seg]', (e, b) => {
      st.gapKind = b.dataset.seg;
      mountControls();
      renderBody();
    }),
    on(page, 'click', '[data-seg-name="withleads"] [data-seg]', (e, b) => {
      st.onlyWithLeads = b.dataset.seg === 'leads';
      mountControls();
      renderBody();
    }),
    on(page, 'click', '[data-sort]', (e, b) => {
      const [table, key] = b.dataset.sort.split(':');
      const cur = st.sorts[table];
      st.sorts[table] = cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: -1 };
      renderBody();
    }),
    on(page, 'click', '[data-more]', (e, b) => {
      st.expanded[b.dataset.more] = !st.expanded[b.dataset.more];
      renderBody();
    }),
    on(page, 'click', '[data-edit]', (e, b) => {
      st.editing = st.editing === b.dataset.edit ? null : b.dataset.edit;
      renderBody();
    }),
    on(page, 'click', '[data-edit-close]', () => {
      st.editing = null;
      renderBody();
    }),
    on(page, 'click', '[data-motivo]', (e, b) => {
      if (st.editing) saveAttribution(st.editing, { motivo: b.dataset.motivo }, `Motivo: ${b.dataset.motivo}`);
    }),
    on(page, 'submit', '[data-motivo-form]', (e, f) => {
      e.preventDefault();
      const m = f.motivo.value.trim();
      if (!m) {
        toast('Escribe el motivo o elige uno de los botones', { error: true });
        return;
      }
      if (st.editing) saveAttribution(st.editing, { motivo: m }, `Motivo: ${m}`);
    }),
    on(page, 'click', '[data-clear]', () => {
      if (st.editing) saveAttribution(st.editing, {}, 'Atribución manual quitada');
    }),
    on(page, 'click', '[data-assign]', (e, b) => {
      st.assigning = st.assigning === b.dataset.assign ? null : b.dataset.assign;
      renderBody();
    }),
    on(page, 'click', '[data-assign-close]', () => {
      st.assigning = null;
      renderBody();
    }),
    on(page, 'change', '[data-gap-select]', (e, sel) => assignGap(sel)),
  ];

  showView();

  return () => {
    ctrl?.abort();
    offs.forEach((off) => off());
  };
}
