// Recursos y Ángulos (como RecursosAngulosPageClient de la versión completa): la Cápsula de
// Recursos (lead magnets con link para copiar) y los ángulos de contenido, en una
// sola página. Todos leen; solo un admin crea, edita, borra y reordena.
import { del, get, patch, post } from '../core/api.js';
import { esc } from '../core/dom.js';
import { attempt, confirmDialog, loading, toast } from '../core/ui.js';

const safeHref = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const usos = (n) => (n === 1 ? 'Usado en 1 contenido' : `Usado en ${n} contenidos`);

function copyText(textValue, btn, label) {
  const done = () => {
    btn.textContent = 'Copiado ✓';
    setTimeout(() => (btn.textContent = label), 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(textValue).then(done, () => toast('No se pudo copiar', { error: true }));
  else toast('Copia el link a mano', { error: true });
}

export async function render(root, ctx) {
  const isAdmin = ctx.isAdmin;
  const state = { recursos: [], angulos: [], editRecurso: null, editAngulo: null };

  root.innerHTML = `
    <div class="crm-page dx-page content-library">
      <div class="crm-toolbar">
        <div>
          <span class="crm-eyebrow">Contenido</span>
          <h1>${esc(ctx.page.title)}</h1>
        </div>
        <span class="save-status" data-saved>Guardado ✓</span>
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

  const data = await attempt(() => Promise.all([get('/recursos'), get('/angulos')]));
  if (!data) {
    body.innerHTML = `<div class="lite-empty">No se pudo cargar. Recarga la página para intentar de nuevo.</div>`;
    return;
  }
  state.recursos = data[0].recursos;
  state.angulos = data[1].angulos;
  paint();

  // ------------------------------------------------------------ dibujo
  function recursoForm(r = {}) {
    return `
      <form class="content-angle-form content-library-form" data-recurso-form="${esc(r.id || '')}" novalidate>
        <input name="nombre" maxlength="200" placeholder="Nombre del recurso" value="${esc(r.nombre || '')}" aria-label="Nombre">
        <input name="link" maxlength="2000" placeholder="Link (https://…)" value="${esc(r.link || '')}" aria-label="Link">
        <input name="tipo" maxlength="80" placeholder="Tipo (PDF, video, guía…)" value="${esc(r.tipo || '')}" aria-label="Tipo">
        <input name="descripcion" maxlength="2000" placeholder="Qué problema resuelve" value="${esc(r.descripcion || '')}" aria-label="Descripción">
        <div class="content-angle-form-actions">
          <button type="submit">Guardar</button>
          <button type="button" data-cancel>Cancelar</button>
        </div>
      </form>`;
  }

  function anguloForm(a = {}) {
    return `
      <form class="content-angle-form content-library-form" data-angulo-form="${esc(a.id || '')}" novalidate>
        <input name="nombre" maxlength="120" placeholder="Nombre del ángulo" value="${esc(a.nombre || '')}" aria-label="Nombre">
        <input name="descripcion" maxlength="2000" placeholder="Descripción (de qué se trata, a quién le habla)" value="${esc(a.descripcion || '')}" aria-label="Descripción">
        <div class="content-angle-form-actions">
          <button type="submit">Guardar</button>
          <button type="button" data-cancel>Cancelar</button>
        </div>
      </form>`;
  }

  function recursoItem(r) {
    if (state.editRecurso === r.id) return recursoForm(r);
    const href = safeHref(r.link);
    const meta = [r.tipo, usos(r.usos || 0)].filter(Boolean).join(' · ');
    return `
      <div class="content-reference-item">
        <div class="content-reference-item-main">
          ${
            href
              ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="content-reference-item-name">${esc(r.nombre)}</a>`
              : `<span class="content-reference-item-name">${esc(r.nombre)}</span>`
          }
          ${r.link ? `<span class="content-reference-item-sub content-library-url">${esc(r.link)}</span>` : ''}
          ${r.descripcion ? `<span class="content-reference-item-sub">Resuelve: ${esc(r.descripcion)}</span>` : ''}
          <span class="content-reference-item-tags"><span class="crm-card-tag">${esc(meta)}</span></span>
        </div>
        <span class="sop-item-actions">
          ${href ? `<button type="button" class="sop-edit-btn" data-copy="${esc(r.link)}">Copiar link</button>` : ''}
          ${
            isAdmin
              ? `<button type="button" class="sop-edit-btn" data-edit-recurso="${esc(r.id)}">Editar</button>
                 <button type="button" class="sop-delete-btn" title="Eliminar" aria-label="Eliminar" data-del-recurso="${esc(r.id)}">✕</button>`
              : ''
          }
        </span>
      </div>`;
  }

  function anguloItem(a, i) {
    if (state.editAngulo === a.id) return anguloForm(a);
    return `
      <div class="content-reference-item">
        <div class="content-reference-item-main">
          <span class="content-reference-item-name">${esc(a.nombre)}</span>
          ${a.descripcion ? `<span class="content-reference-item-sub">${esc(a.descripcion)}</span>` : ''}
          <span class="content-reference-item-tags"><span class="crm-card-tag">${esc(usos(a.usos || 0))}</span></span>
        </div>
        ${
          isAdmin
            ? `<span class="sop-item-actions">
                 <button type="button" class="sop-edit-btn content-move-btn" title="Subir" aria-label="Subir" data-move="${esc(a.id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
                 <button type="button" class="sop-edit-btn content-move-btn" title="Bajar" aria-label="Bajar" data-move="${esc(a.id)}" data-dir="1" ${i === state.angulos.length - 1 ? 'disabled' : ''}>↓</button>
                 <button type="button" class="sop-edit-btn" data-edit-angulo="${esc(a.id)}">Editar</button>
                 <button type="button" class="sop-delete-btn" title="Eliminar" aria-label="Eliminar" data-del-angulo="${esc(a.id)}">✕</button>
               </span>`
            : ''
        }
      </div>`;
  }

  function paint() {
    body.innerHTML = `
      <span class="content-section-label">📂 Cápsula de Recursos</span>
      <p class="content-library-hint">Los regalos que se envían por DM (guías, videos, checklists). Vincúlalos a cada contenido para tener el link a mano.</p>
      <div class="content-reference-list">
        ${state.recursos.length || state.editRecurso === 'new' ? '' : '<p class="crm-notes-empty">Sin recursos cargados todavía.</p>'}
        ${state.recursos.map(recursoItem).join('')}
        ${isAdmin ? (state.editRecurso === 'new' ? recursoForm() : '<button type="button" class="add-bubble-btn" data-new-recurso>+ Agregar recurso</button>') : ''}
      </div>

      <span class="content-section-label">🎯 Ángulos de contenido</span>
      <p class="content-library-hint">Los temas desde los que hablas. Cada contenido lleva uno, y en Resultados se ve cuál trae más agendas y ventas.</p>
      <div class="content-reference-list">
        ${state.angulos.length || state.editAngulo === 'new' ? '' : '<p class="crm-notes-empty">Sin ángulos cargados todavía.</p>'}
        ${state.angulos.map(anguloItem).join('')}
        ${isAdmin ? (state.editAngulo === 'new' ? anguloForm() : '<button type="button" class="add-bubble-btn" data-new-angulo>+ Agregar ángulo</button>') : ''}
      </div>`;
    const first = body.querySelector('form input[name=nombre]');
    if (first && !first.value) first.focus();
  }

  // ------------------------------------------------------------ acciones
  root.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const copy = t.closest('[data-copy]');
    if (copy) return copyText(copy.dataset.copy, copy, 'Copiar link');
    if (!isAdmin) return;
    if (t.closest('[data-new-recurso]')) {
      state.editRecurso = 'new';
      return paint();
    }
    if (t.closest('[data-new-angulo]')) {
      state.editAngulo = 'new';
      return paint();
    }
    const er = t.closest('[data-edit-recurso]');
    if (er) {
      state.editRecurso = er.dataset.editRecurso;
      return paint();
    }
    const ea = t.closest('[data-edit-angulo]');
    if (ea) {
      state.editAngulo = ea.dataset.editAngulo;
      return paint();
    }
    const cancel = t.closest('[data-cancel]');
    if (cancel) {
      if (cancel.closest('[data-recurso-form]')) state.editRecurso = null;
      else state.editAngulo = null;
      return paint();
    }
    const dr = t.closest('[data-del-recurso]');
    if (dr) {
      const r = state.recursos.find((x) => x.id === dr.dataset.delRecurso);
      if (!r) return;
      const extra = r.usos ? ` Se va a desvincular de ${r.usos === 1 ? '1 contenido' : `${r.usos} contenidos`}.` : '';
      if (!(await confirmDialog(`¿Eliminar el recurso «${r.nombre}»?${extra}`, { ok: 'Eliminar', danger: true }))) return;
      if (await attempt(() => del(`/recursos/${r.id}`))) {
        state.recursos = state.recursos.filter((x) => x.id !== r.id);
        flashSaved();
        paint();
      }
      return;
    }
    const da = t.closest('[data-del-angulo]');
    if (da) {
      const a = state.angulos.find((x) => x.id === da.dataset.delAngulo);
      if (!a) return;
      const extra = a.usos ? ` ${a.usos === 1 ? 'El contenido que lo usa queda' : `Los ${a.usos} contenidos que lo usan quedan`} sin ángulo.` : '';
      if (!(await confirmDialog(`¿Eliminar el ángulo «${a.nombre}»?${extra}`, { ok: 'Eliminar', danger: true }))) return;
      if (await attempt(() => del(`/angulos/${a.id}`))) {
        state.angulos = state.angulos.filter((x) => x.id !== a.id);
        flashSaved();
        paint();
      }
      return;
    }
    const mv = t.closest('[data-move]');
    if (mv) {
      const i = state.angulos.findIndex((x) => x.id === mv.dataset.move);
      const j = i + Number(mv.dataset.dir);
      if (i < 0 || j < 0 || j >= state.angulos.length) return;
      const prev = state.angulos;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      state.angulos = next;
      paint();
      const r = await attempt(() => post('/angulos/orden', { ids: next.map((a) => a.id) }));
      if (r) {
        state.angulos = r.angulos;
        flashSaved();
      } else state.angulos = prev;
      paint();
    }
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !isAdmin) return;
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    if (!String(fd.nombre || '').trim()) {
      toast('Escribe el nombre', { error: true });
      form.nombre.focus();
      return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (form.dataset.recursoForm !== undefined) {
        const id = form.dataset.recursoForm;
        const r = id ? await patch(`/recursos/${id}`, fd) : await post('/recursos', fd);
        state.recursos = id ? state.recursos.map((x) => (x.id === id ? r.recurso : x)) : [...state.recursos, r.recurso];
        state.recursos.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        state.editRecurso = null;
      } else {
        const id = form.dataset.anguloForm;
        const r = id ? await patch(`/angulos/${id}`, fd) : await post('/angulos', fd);
        state.angulos = id ? state.angulos.map((x) => (x.id === id ? r.angulo : x)) : [...state.angulos, r.angulo];
        state.editAngulo = null;
      }
      flashSaved();
      paint();
    } catch (ex) {
      toast(ex.message, { error: true });
      btn.disabled = false;
    }
  });
}
