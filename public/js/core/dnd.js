// Arrastrar y soltar con eventos de puntero (mouse y dedo), como dnd-kit en
// la versión completa. El drag & drop nativo de HTML5 no funciona en celulares táctiles.
//
//   const stop = enableDrag(container, {
//     item: '.crm-card[data-card]',            // qué se arrastra
//     zone: '.crm-column[data-stage]',          // dónde se puede soltar
//     list: (zone) => zone.querySelector('.crm-column-body'), // dónde se inserta el marcador (opcional)
//     canDrag: (el) => true,
//     onDrop: ({ item, zone, before }) => {},   // before = elemento que queda debajo (o null)
//     overlayClass: 'crm-card crm-card-overlay',
//   });
//
// - Con mouse arranca al moverse 5 px; con el dedo, al mantener presionado 220 ms
//   (así el scroll de la página sigue funcionando).
// - Mientras se arrastra: copia flotante bajo el puntero, el original tenue, una
//   línea naranja donde va a caer y la zona resaltada (.lite-drop-over).
// - Si no hay `list`, se suelta en la zona sin marcador (ej. un día del calendario).
// - Un clic normal no se ve afectado (si no hubo arrastre, el click pasa).

const MOUSE_DISTANCE = 5;
const TOUCH_DELAY = 220;
const TOUCH_TOLERANCE = 8;

export function enableDrag(container, opts) {
  const { item, zone, list = null, canDrag = () => true, onDrop, overlayClass = '' } = opts;
  let pending = null;
  let drag = null;
  let suppressClick = false;

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const el = e.target.closest?.(item);
    if (!el || !container.contains(el) || !canDrag(el)) return;
    if (e.target.closest('button, a, input, select, textarea, [data-no-drag]')) return;
    pending = { el, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== 'mouse', timer: 0 };
    if (pending.touch) {
      pending.timer = setTimeout(() => pending && start(pending.x, pending.y), TOUCH_DELAY);
    }
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
  }

  function start(x, y) {
    const el = pending.el;
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.className = `${el.className} ${overlayClass} lite-drag-ghost`.trim();
    ghost.removeAttribute('data-card');
    Object.assign(ghost.style, { width: `${r.width}px`, left: '0px', top: '0px' });
    document.body.appendChild(ghost);
    el.classList.add('lite-dragging');
    document.documentElement.classList.add('lite-is-dragging');
    drag = { el, ghost, dx: x - r.left, dy: y - r.top, zone: null, marker: null };
    if (navigator.vibrate && pending.touch) navigator.vibrate(8);
    pending = null;
    position(x, y);
  }

  function position(x, y) {
    drag.ghost.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px) rotate(1.5deg)`;
    drag.ghost.style.visibility = 'hidden';
    const under = document.elementFromPoint(x, y);
    drag.ghost.style.visibility = '';
    const z = under?.closest(zone);
    const target = z && container.contains(z) ? z : null;
    if (target !== drag.zone) {
      drag.zone?.classList.remove('lite-drop-over');
      target?.classList.add('lite-drop-over');
      drag.zone = target;
    }
    if (!list) return;
    if (!target) {
      drag.marker?.remove();
      drag.marker = null;
      return;
    }
    const box = list(target) || target;
    if (!drag.marker) drag.marker = Object.assign(document.createElement('div'), { className: 'lite-drop-marker' });
    const items = [...box.querySelectorAll(item)].filter((n) => n !== drag.el && n.parentElement === box);
    const next = items.find((n) => {
      const r = n.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (next) box.insertBefore(drag.marker, next);
    else box.appendChild(drag.marker);
    autoScroll(box, x, y);
  }

  // Scroll automático cerca de los bordes (columna y tablero).
  function autoScroll(box, x, y) {
    const edge = 40;
    const scrollers = [box, box.closest('.crm-board'), document.scrollingElement];
    for (const s of scrollers) {
      if (!s) continue;
      const r = s === document.scrollingElement ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth } : s.getBoundingClientRect();
      if (y < r.top + edge) s.scrollTop -= 12;
      else if (y > r.bottom - edge) s.scrollTop += 12;
      if (x < r.left + edge) s.scrollLeft -= 12;
      else if (x > r.right - edge) s.scrollLeft += 12;
    }
  }

  function onMove(e) {
    if (pending && e.pointerId === pending.id) {
      const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
      if (pending.touch) {
        if (dist > TOUCH_TOLERANCE) cancel(); // quiso scrollear
        return;
      }
      if (dist >= MOUSE_DISTANCE) start(e.clientX, e.clientY);
      else return;
    }
    if (!drag) return;
    e.preventDefault();
    position(e.clientX, e.clientY);
  }

  function onUp() {
    if (drag) {
      const { el, zone: z, marker } = drag;
      const before = marker ? marker.nextElementSibling?.closest(item) || null : null;
      finish();
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      if (z) onDrop({ item: el, zone: z, before: before && before !== el ? before : null });
      return;
    }
    cancel();
  }

  function finish() {
    if (!drag) return;
    drag.ghost.remove();
    drag.marker?.remove();
    drag.zone?.classList.remove('lite-drop-over');
    drag.el.classList.remove('lite-dragging');
    document.documentElement.classList.remove('lite-is-dragging');
    drag = null;
    cleanupListeners();
  }

  function cancel() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
    finish();
    cleanupListeners();
  }

  function cleanupListeners() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
  }

  // Evita el clic que dispara el navegador al soltar después de arrastrar.
  function onClickCapture(e) {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }
  // En touch, que el menú contextual del mantener presionado no tape el arrastre.
  function onContext(e) {
    if (drag || pending) e.preventDefault();
  }

  container.addEventListener('pointerdown', onDown);
  container.addEventListener('click', onClickCapture, true);
  container.addEventListener('contextmenu', onContext);
  return () => {
    cancel();
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('click', onClickCapture, true);
    container.removeEventListener('contextmenu', onContext);
  };
}

/** true mientras hay un arrastre en curso (para no refrescar la pantalla en ese momento). */
export const isDragging = () => document.documentElement.classList.contains('lite-is-dragging');
