// Efectos tipo Apple de la versión completa, igual que components/fx de allá, sin librerías:
//  1. Brillo de borde que sigue al mouse (un único overlay #fx-spot).
//  2. «Dock»: el botón bajo el mouse se agranda y sube, los vecinos lo siguen (resorte).
//  3. La barra de controles se compacta al bajar (data-fx-scrolled en <html>).
//  4. Indicador activo que se desliza (sidebar, toggles, controles segmentados, tabs).
//  5. Ráfaga de corazones/estrellas (burst) para celebrar una venta.
// Todo se apaga con touch y con prefers-reduced-motion. El sidebar no lleva brillo ni dock.

const SCOPE = '.app-main, .crm-panel, .login-page';
const CONTROLS = [
  'button',
  'select',
  'textarea',
  'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range])',
  '[role=tab]',
];
const CARD_CLASSES = [
  '.crm-card',
  '.goals-person-card',
  '.stat-tile',
  '.dx-hero',
  '.dx-step',
  '.dx-tile',
  '.dx-team-stat',
  '.dx-card',
  '.dx-range-pill',
  '.clients-table-wrap',
  '.perf-table-wrap',
  '.users-table-wrap',
  '.sales-attribution-table-wrap',
  '.eod-breakdown-wrap',
  '.lite-card',
];
const PREFER_SELECTOR = ['.crm-search', '.crm-view-toggle', '.dx-seg', '.content-calendar-subview-toggle'].join(',');
const SPOT_SELECTOR = [...CARD_CLASSES, PREFER_SELECTOR, ...CONTROLS.map((c) => `:is(${SCOPE}) ${c}`)].join(',');
const WHITE_SPOT_SELECTOR = '.dx-hero, .dx-team-stat.dark, .crm-create-btn, .crm-chip.active, .crm-outcome-save';
const DOCK_SELECTOR =
  '.dx-seg, .crm-view-toggle, .crm-filter-row, .dashboard-range-row, .crm-tabs, .content-calendar-subview-toggle, .content-calendar-nav';
const DOCK_RANGE = 110;
const DOCK_MAX_SCALE = 1.14;
const DOCK_LIFT = -2.5;

export function initFx() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 1. Brillo de borde ----------
  const spot = document.createElement('div');
  spot.id = 'fx-spot';
  spot.setAttribute('aria-hidden', 'true');
  document.body.appendChild(spot);
  let spotTarget = null;
  let spotRect = null;

  function showSpot(target) {
    const rect = target.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || rect.height > 640) return hideSpot();
    spotTarget = target;
    spotRect = rect;
    const cs = getComputedStyle(target);
    spot.style.left = `${rect.left}px`;
    spot.style.top = `${rect.top}px`;
    spot.style.width = `${rect.width}px`;
    spot.style.height = `${rect.height}px`;
    spot.style.borderRadius = cs.borderRadius;
    spot.style.setProperty('--fx-rgb', target.closest(WHITE_SPOT_SELECTOR) ? '255,255,255' : 'var(--accent-rgb)');
    spot.style.opacity = '1';
  }
  function hideSpot() {
    spotTarget = null;
    spotRect = null;
    spot.style.opacity = '0';
  }

  // ---------- 2. Dock ----------
  const dockItems = new Map();
  let dockContainer = null;
  let dockMouseX = Infinity;
  let raf = 0;

  function dockTargets() {
    if (!dockContainer) return;
    const kids = Array.from(dockContainer.children).filter((c) => c instanceof HTMLElement && (c.tagName === 'BUTTON' || c.tagName === 'A'));
    for (const el of kids) {
      let item = dockItems.get(el);
      if (!item) {
        item = { el, s: 1, y: 0, vs: 0, vy: 0, ts: 1, ty: 0 };
        el.classList.add('fx-dock-child');
        dockItems.set(el, item);
      }
      if (dockMouseX === Infinity) {
        item.ts = 1;
        item.ty = 0;
      } else {
        const r = el.getBoundingClientRect();
        const k = Math.max(0, 1 - Math.abs(dockMouseX - (r.left + r.width / 2)) / DOCK_RANGE);
        item.ts = 1 + (DOCK_MAX_SCALE - 1) * k;
        item.ty = DOCK_LIFT * k;
      }
    }
  }

  function tick() {
    raf = 0;
    let moving = false;
    dockItems.forEach((it, el) => {
      it.vs = (it.vs + (it.ts - it.s) * 0.2) * 0.7;
      it.vy = (it.vy + (it.ty - it.y) * 0.2) * 0.7;
      it.s += it.vs;
      it.y += it.vy;
      const settled = Math.abs(it.ts - it.s) < 0.001 && Math.abs(it.ty - it.y) < 0.01 && Math.abs(it.vs) < 0.001;
      if (settled && it.ts === 1) {
        el.style.transform = '';
        dockItems.delete(el);
      } else {
        el.style.transform = `translateY(${it.y.toFixed(2)}px) scale(${it.s.toFixed(3)})`;
        moving = true;
      }
    });
    if (moving) raf = requestAnimationFrame(tick);
  }
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };

  let pending = null;
  let frame = 0;
  function handleMove(e) {
    if (e.pointerType !== 'mouse') return;
    const target = e.target instanceof Element ? e.target : null;
    if (e.buttons !== 0) {
      if (spotTarget) hideSpot();
      return;
    }
    let spotEl = target?.closest(SPOT_SELECTOR) ?? null;
    if (spotEl) {
      const preferred = spotEl.closest(PREFER_SELECTOR);
      if (preferred) spotEl = preferred;
      if (spotEl.closest('.fx-no, .crm-tabs') || spotEl.disabled) spotEl = null;
    }
    if (spotEl !== spotTarget) {
      if (spotEl) showSpot(spotEl);
      else hideSpot();
    }
    if (spotTarget && spotRect) {
      spot.style.setProperty('--sx', `${e.clientX - spotRect.left}px`);
      spot.style.setProperty('--sy', `${e.clientY - spotRect.top}px`);
    }
    if (!reduce) {
      const dc = target?.closest(DOCK_SELECTOR) ?? null;
      if (dc !== dockContainer) {
        dockMouseX = Infinity;
        dockTargets();
        dockContainer = dc;
      }
      if (dockContainer) {
        dockMouseX = e.clientX;
        dockTargets();
        kick();
      }
    }
  }

  document.addEventListener(
    'pointermove',
    (e) => {
      pending = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) handleMove(pending);
        pending = null;
      });
    },
    { passive: true },
  );
  const onLeave = () => {
    hideSpot();
    dockMouseX = Infinity;
    dockTargets();
    dockContainer = null;
    kick();
  };
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);

  // ---------- 3. Compactar al bajar ----------
  let lastY = Math.max(0, window.scrollY);
  window.addEventListener(
    'scroll',
    () => {
      const y = Math.max(0, window.scrollY);
      const diff = y - lastY;
      const root = document.documentElement;
      if (y <= 30) root.removeAttribute('data-fx-scrolled');
      else if (diff > 4) root.setAttribute('data-fx-scrolled', '1');
      else if (diff < -4) root.removeAttribute('data-fx-scrolled');
      lastY = y;
      hideSpot();
    },
    { passive: true },
  );

  initSliders();
}

// ---------- 4. Indicador deslizante ----------
const SLIDERS = [
  { container: '.sidebar-nav', active: '.sidebar-link.active', aria: false },
  { container: '.crm-view-toggle', active: 'button.active', aria: true },
  { container: '.dx-seg', active: 'button.active', aria: true },
  { container: '.content-calendar-subview-toggle', active: 'button.active', aria: true },
  { container: '.crm-tabs', active: 'button.active', aria: true },
];
const ALL_CONTAINERS = SLIDERS.map((s) => s.container).join(',');
const TABLIST_SELECTOR = SLIDERS.filter((s) => s.aria).map((s) => s.container).join(',');

function relativeBox(el, container) {
  let x = 0;
  let y = 0;
  let n = el;
  while (n && n !== container) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight, ok: n === container };
}

function sync(container) {
  const cfg = SLIDERS.find((s) => container.matches(s.container));
  if (!cfg) return;
  const active = container.querySelector(cfg.active);
  if (cfg.aria) {
    container.setAttribute('role', 'tablist');
    container.querySelectorAll(':scope > button').forEach((b) => {
      b.setAttribute('role', 'tab');
      const isOn = b === active;
      b.setAttribute('aria-selected', isOn ? 'true' : 'false');
      b.tabIndex = isOn ? 0 : -1;
    });
  }
  if (!active) {
    container.removeAttribute('data-ind');
    return;
  }
  const box = relativeBox(active, container);
  if (!box.ok || box.w === 0) return;
  container.style.setProperty('--ind-x', `${box.x}px`);
  container.style.setProperty('--ind-y', `${box.y}px`);
  container.style.setProperty('--ind-w', `${box.w}px`);
  container.style.setProperty('--ind-h', `${box.h}px`);
  if (!container.hasAttribute('data-ind')) {
    container.setAttribute('data-ind', '1');
    container.removeAttribute('data-ind-ready');
    requestAnimationFrame(() => requestAnimationFrame(() => container.setAttribute('data-ind-ready', '1')));
  }
}

function initSliders() {
  const seen = new WeakSet();
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const c = e.target.closest(ALL_CONTAINERS);
      if (c) sync(c);
    }
  });
  function scan() {
    document.querySelectorAll(ALL_CONTAINERS).forEach((c) => {
      if (!seen.has(c)) {
        seen.add(c);
        ro.observe(c);
      }
      sync(c);
    });
  }
  const dirty = new Set();
  let fullScan = false;
  let scheduled = 0;
  function flush() {
    scheduled = 0;
    if (fullScan) {
      fullScan = false;
      dirty.clear();
      scan();
      return;
    }
    const list = Array.from(dirty);
    dirty.clear();
    list.forEach((c) => c.isConnected && sync(c));
  }
  const schedule = () => {
    if (!scheduled) scheduled = requestAnimationFrame(flush);
  };
  const hasContainer = (n) => n instanceof Element && (n.matches(ALL_CONTAINERS) || n.querySelector(ALL_CONTAINERS) !== null);
  new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target instanceof Element ? r.target : null;
      const owner = t?.closest(ALL_CONTAINERS) ?? null;
      if (owner) {
        dirty.add(owner);
        schedule();
      }
      if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) {
          if (hasContainer(n)) {
            fullScan = true;
            schedule();
            break;
          }
        }
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

  document.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const t = e.target;
    const list = t?.closest?.(TABLIST_SELECTOR);
    if (!list || t.tagName !== 'BUTTON' || t.parentElement !== list) return;
    const tabs = Array.from(list.querySelectorAll(':scope > button')).filter((b) => !b.disabled);
    const i = tabs.indexOf(t);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else next = tabs.length - 1;
    e.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });
  window.addEventListener('resize', () => {
    fullScan = true;
    schedule();
  });
  scan();
}

// ---------- 5. Ráfaga ----------
const GRADS = [
  ['var(--accent-2)', 'var(--accent)'],
  ['var(--accent)', '#d946ef'],
  ['#6366f1', '#d946ef'],
  ['#10b981', '#6ee7b7'],
];
const HEART =
  'M12 21.35L10.55 20.03C5.4 15.36 2 12.28 2 8.5C2 5.42 4.42 3 7.5 3C9.24 3 10.91 3.81 12 5.09C13.09 3.81 14.76 3 16.5 3C19.58 3 22 5.42 22 8.5C22 12.28 18.6 15.36 13.45 20.04L12 21.35Z';
const STAR = 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.8-6.3 3.8 1.7-7L2 9.2l7.1-.6z';

export function burst(anchor, count = 6) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = anchor?.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'fx-burst';
  box.setAttribute('aria-hidden', 'true');
  box.style.left = `${r ? r.left + r.width / 2 : window.innerWidth / 2}px`;
  box.style.top = `${r ? r.top : window.innerHeight / 2}px`;
  const uid = Math.random().toString(36).slice(2, 7);
  for (let i = 0; i < count; i++) {
    const [a, b] = GRADS[i % GRADS.length];
    const p = document.createElement('span');
    p.className = 'fx-burst-p';
    p.style.setProperty('--dx', `${(i - (count - 1) / 2) * 22 + (Math.random() * 10 - 5)}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 50 - 25)}deg`);
    p.style.setProperty('--sc', (0.85 + Math.random() * 0.5).toFixed(2));
    p.style.setProperty('--d', `${(i * 0.07).toFixed(2)}s`);
    p.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><defs><linearGradient id="fxg${uid}${i}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" style="stop-color:${a}"/><stop offset="1" style="stop-color:${b}"/></linearGradient></defs><path d="${i % 3 === 2 ? STAR : HEART}" fill="url(#fxg${uid}${i})"/></svg>`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1800);
}
