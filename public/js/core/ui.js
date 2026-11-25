// Piezas de pantalla compartidas, con el mismo marcado (y por lo tanto el mismo
// look) que los componentes de la versión completa: SidePanel, DxHeader, DxSeg, DxTile,
// DxHero, DxRangeControls, ViewHubToggle, ExpandableSearch, WaveText.
// Cada función devuelve un string de HTML o un elemento, según se indica.
import { esc, h, icons } from './dom.js';
import { PRESETS, rangeForPreset, rangeLabel } from './dates.js';

// ---------------------------------------------------------------- panel lateral
/**
 * Abre un panel lateral (como SidePanel de la versión completa). Devuelve { el, body, close, setTitle }.
 * Se cierra con ✕, Esc o clic afuera. onClose se llama al cerrar.
 */
export function sidePanel(title, { wide = false, onClose } = {}) {
  const overlay = h(`
    <div class="crm-panel-overlay">
      <div class="crm-panel${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="crm-panel-header">
          <h2>${esc(title)}</h2>
          <button type="button" class="crm-panel-close" aria-label="Cerrar">✕</button>
        </div>
        <div class="crm-panel-body"></div>
      </div>
    </div>`);
  const body = overlay.querySelector('.crm-panel-body');
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    onClose?.();
  }
  function onKey(e) {
    if (e.key === 'Escape' && !document.querySelector('.lite-modal-overlay')) close();
  }
  overlay.addEventListener('click', (e) => e.target === overlay && close());
  overlay.querySelector('.crm-panel-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return {
    el: overlay,
    body,
    close,
    setTitle: (t) => (overlay.querySelector('.crm-panel-header h2').textContent = t),
  };
}

// ---------------------------------------------------------------- diálogo de confirmación
/** Promesa true/false. danger = botón rojo. */
export function confirmDialog(message, { ok = 'Confirmar', cancel = 'Cancelar', danger = false, title = '' } = {}) {
  return new Promise((resolve) => {
    const el = h(`
      <div class="lite-modal-overlay">
        <div class="lite-modal" role="alertdialog" aria-modal="true">
          ${title ? `<h3>${esc(title)}</h3>` : ''}
          <p>${esc(message)}</p>
          <div class="lite-modal-actions">
            <button type="button" class="btn-secondary" data-no>${esc(cancel)}</button>
            <button type="button" class="${danger ? 'btn-danger' : 'crm-create-btn'}" data-yes>${esc(ok)}</button>
          </div>
        </div>
      </div>`);
    const done = (v) => {
      el.remove();
      document.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    el.querySelector('[data-no]').onclick = () => done(false);
    el.querySelector('[data-yes]').onclick = () => done(true);
    el.addEventListener('click', (e) => e.target === el && done(false));
    document.addEventListener('keydown', key, true);
    document.body.appendChild(el);
    el.querySelector('[data-yes]').focus();
  });
}

// ---------------------------------------------------------------- avisos
let toastWrap;
export function toast(message, { error = false, ms = 3200 } = {}) {
  if (!toastWrap) {
    toastWrap = h('<div class="lite-toasts" aria-live="polite"></div>');
    document.body.appendChild(toastWrap);
  }
  const t = h(`<div class="lite-toast${error ? ' error' : ''}">${esc(message)}</div>`);
  toastWrap.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

/** Corre fn y muestra el error en un aviso rojo (devuelve null si falló). */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.name !== 'AbortError') toast(err?.message || 'Algo salió mal', { error: true });
    return null;
  }
}

// ---------------------------------------------------------------- encabezados y piezas dx
/** Encabezado estándar de los tableros (string). actionsHtml va a la derecha. */
export function dxHeader({ eyebrow, title, rangeText = '', actionsHtml = '' }) {
  return `
    <div class="dx-head">
      <div>
        <span class="crm-eyebrow">${esc(eyebrow)}</span>
        <h1 class="dx-title">${esc(title)}</h1>
      </div>
      <div class="dx-head-right">
        ${actionsHtml}
        ${rangeText ? `<span class="dx-range-pill">${icons.calendar}${esc(rangeText.charAt(0).toUpperCase() + rangeText.slice(1))}</span>` : ''}
      </div>
    </div>`;
}

/** Control segmentado (string). Botones con data-seg="<key>". */
export function dxSeg(options, value, { soft = false, label = '', name = '' } = {}) {
  return `
    <div class="dx-seg${soft ? ' dx-seg-soft' : ''}" role="tablist" aria-label="${esc(label)}" ${name ? `data-seg-name="${esc(name)}"` : ''}>
      ${options
        .map(
          (o) =>
            `<button type="button" role="tab" aria-selected="${o.key === value}" class="dx-seg-btn${o.key === value ? ' active' : ''}" data-seg="${esc(o.key)}">${esc(o.label)}</button>`,
        )
        .join('')}
    </div>`;
}

/** Toggle de vistas tipo Kanban/Lista (string). Botones con data-view="<key>". */
export function viewToggle(views, current, label = 'Vista') {
  return `
    <div class="crm-view-toggle" role="tablist" aria-label="${esc(label)}">
      ${views.map((v) => `<button type="button" data-view="${esc(v.key)}" class="${v.key === current ? 'active' : ''}">${esc(v.label)}</button>`).join('')}
    </div>`;
}

export function dxTile({ icon = icons.chart, tone = 'peach', label, value, sub = '', index = 0 }) {
  return `
    <div class="dx-tile" style="--i:${index}">
      <span class="dx-tile-icon tone-${tone}">${icon}</span>
      <span class="dx-tile-label">${esc(label)}</span>
      <span class="dx-tile-value">${value}</span>
      ${sub ? `<span class="dx-tile-sub">${sub}</span>` : ''}
    </div>`;
}

export const dxTiles = (inner) => `<div class="dx-tiles">${inner}</div>`;
export const dxSectionLabel = (t) => `<span class="dx-section-label">${esc(t)}</span>`;
export const dxCard = (inner, cls = '') => `<div class="dx-card ${cls}">${inner}</div>`;

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;
/** Tarjeta oscura de la cifra principal. progress (0–100) = barra; ring (0–100) = anillo. */
export function dxHero({ label, value, noteHtml = '', actionHtml = '', progress = null, ring = null, ringLabel = 'de la meta', index = 0 }) {
  const p = ring == null ? null : Math.min(Math.max(ring, 0), 100);
  return `
    <section class="dx-hero" style="--i:${index}">
      <div class="dx-hero-main">
        <div class="dx-hero-top">
          <span class="dx-hero-label"><span class="dx-hero-dot"></span>${esc(label)}</span>
          ${actionHtml}
        </div>
        <span class="dx-hero-value">${esc(value)}</span>
        ${progress != null ? `<div class="dx-hero-track"><div class="dx-hero-fill" style="width:${Math.min(Math.max(progress, 0), 100)}%"></div></div>` : ''}
        ${noteHtml ? `<span class="dx-hero-goal">${noteHtml}</span>` : ''}
      </div>
      ${
        p !== null
          ? `<div class="dx-ring" aria-label="${p.toFixed(0)}% ${esc(ringLabel)}">
          <svg viewBox="0 0 132 132">
            <circle class="dx-ring-track" cx="66" cy="66" r="${RING_R}"/>
            <circle class="dx-ring-fill" cx="66" cy="66" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C * (1 - p / 100)}" transform="rotate(-90 66 66)"/>
          </svg>
          <div class="dx-ring-text"><strong>${p.toFixed(0)}%</strong><span>${esc(ringLabel)}</span></div>
        </div>`
          : ''
      }
    </section>`;
}

/**
 * Fila de controles de rango (Este mes / Mes pasado / … / Personalizado) como en la versión completa.
 * Devuelve un elemento; llama onChange({ preset, from, to, label }) al cambiar.
 * leadHtml = otro control a la izquierda (opcional): texto o función que devuelve el texto
 * (usar función si ese control tiene estado, así se redibuja con el valor actual).
 */
export function rangeControls({ preset = 'month', from = '', to = '', leadHtml = '', onChange }) {
  const state = { preset, from, to };
  const el = h(`<div class="dx-controls"></div>`);
  function emit() {
    const r = rangeForPreset(state.preset, state.from, state.to);
    if (r) onChange({ preset: state.preset, ...r, label: rangeLabel(r) });
  }
  function render() {
    el.innerHTML = `
      ${typeof leadHtml === 'function' ? leadHtml() : leadHtml}
      ${dxSeg(PRESETS, state.preset, { soft: true, label: 'Rango de fechas', name: 'range' })}
      ${
        state.preset === 'custom'
          ? `<span class="dashboard-custom-range">
              <input type="date" data-from value="${esc(state.from)}"><span>a</span><input type="date" data-to value="${esc(state.to)}">
            </span>`
          : ''
      }`;
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg-name="range"] [data-seg]');
    if (!b) return;
    state.preset = b.dataset.seg;
    if (state.preset === 'custom' && !state.from) {
      const r = rangeForPreset('month');
      state.from = r.from;
      state.to = r.to;
    }
    render();
    emit();
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-from]')) state.from = e.target.value;
    if (e.target.matches('[data-to]')) state.to = e.target.value;
    emit();
  });
  render();
  return {
    el,
    current: () => {
      const r = rangeForPreset(state.preset, state.from, state.to);
      return r ? { preset: state.preset, ...r, label: rangeLabel(r) } : null;
    },
    setBusy: (busy) => {
      el.querySelector('.dx-loading-dot')?.remove();
      if (busy) el.insertAdjacentHTML('beforeend', '<span class="dx-loading-dot">Actualizando…</span>');
    },
  };
}

// ---------------------------------------------------------------- buscador que se expande
/** Elemento buscador (ExpandableSearch). onInput(value). Atajo «/», Esc limpia/cierra. */
export function expandableSearch({ placeholder = 'Buscar…', value = '', width = 410, onInput }) {
  const el = h(`
    <div class="crm-search fx-collapsible${value ? ' open' : ''}" style="--fx-search-w:${width}px" role="search" title="Buscar (atajo: /)">
      ${icons.search}
      <input placeholder="${esc(placeholder)}" value="${esc(value)}" tabindex="${value ? 0 : -1}">
      <span class="fx-search-kbd" ${value ? '' : 'hidden'}>ESC</span>
    </div>`);
  const input = el.querySelector('input');
  const isOpen = () => el.classList.contains('open');
  const kbd = el.querySelector('.fx-search-kbd');
  function open() {
    el.classList.add('open');
    kbd.hidden = false;
    input.tabIndex = 0;
    requestAnimationFrame(() => input.focus());
  }
  function close() {
    el.classList.remove('open');
    kbd.hidden = true;
    input.tabIndex = -1;
    input.blur();
  }
  el.addEventListener('click', () => !isOpen() && open());
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('blur', () => input.value === '' && close());
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (input.value) {
      input.value = '';
      onInput('');
    } else close();
  });
  const onSlash = (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!el.isConnected) return document.removeEventListener('keydown', onSlash);
    e.preventDefault();
    open();
  };
  document.addEventListener('keydown', onSlash);
  return el;
}

/** Texto con ola de letras al pasar el mouse por el botón (WaveText). */
export function waveText(text) {
  return `<span class="fx-wave" aria-label="${esc(text)}">${String(text)
    .split('')
    .map((ch, i) => `<span class="fx-wave-letter" aria-hidden="true" style="animation-delay:${(i * 0.035).toFixed(3)}s">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`)
    .join('')}</span>`;
}

/** Botón «+ Crear …» naranja de la versión completa (string). */
export function createButton(label, attrs = '') {
  return `<button type="button" class="crm-create-btn" ${attrs}>${icons.plus}${waveText(label)}</button>`;
}

export function emptyState(text) {
  return `<div class="lite-empty">${esc(text)}</div>`;
}

export function loading(text = 'Cargando…') {
  return `<div class="lite-loading"><span class="lite-spinner"></span>${esc(text)}</div>`;
}

/** <option>s para un select de usuarios (con «Sin asignar»). */
export function userOptions(usuarios, selected, { roles = null, empty = 'Sin asignar' } = {}) {
  const list = roles ? usuarios.filter((u) => u.roles.some((r) => roles.includes(r)) || u.roles.includes('admin')) : usuarios;
  return `<option value="">${esc(empty)}</option>${list
    .map((u) => `<option value="${esc(u.id)}" ${u.id === selected ? 'selected' : ''}>${esc(u.nombre)}</option>`)
    .join('')}`;
}
