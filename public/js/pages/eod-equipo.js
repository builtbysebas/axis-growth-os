// Pantalla «EOD equipo» (/admin/eod, admin), como EodAdminPageClient de la versión completa:
//  - Revisión: rango de fechas, tabla por setter (sumas del EOD + métricas del CRM),
//    tabla por closer y la lista de reportes cargados con sus respuestas.
//  - Preguntas: crear, editar texto/tipo/roles, activar/desactivar (nunca borrar) y
//    reordenar con subir/bajar.
import { get, patch, post, put } from '../core/api.js';
import { colorOf, esc, icons, initialsOf, money, num, on, pct } from '../core/dom.js';
import { dxCard, dxHeader, dxHero, dxSectionLabel, dxSeg, dxTile, dxTiles, loading, rangeControls, toast } from '../core/ui.js';
import { formatAnswer, normQ } from './eod.js';

const TYPE_LABELS = { numero: 'Número', texto: 'Texto', sino: 'Sí/No' };
const ROLE_LABELS = { setter: 'Setter', closer: 'Closer', coach: 'Coach' };
const ROLES = ['setter', 'closer', 'coach'];
const KNOWN = ['outbound', 'respuestas a outbound', 'inbound', 'follow ups'];
const TABS = [
  { key: 'revision', label: 'Revisión' },
  { key: 'preguntas', label: 'Preguntas' },
];

const avatar = (id, label) => `<span class="dx-person-avatar" style="background:${colorOf(id)}">${esc(initialsOf(label))}</span>`;
const person = (u, extra = '') =>
  `<span class="dx-person">${avatar(u.id, u.nombre || u.email)}<span class="dx-person-name">${esc(u.nombre || u.email)}</span>${extra}</span>`;
const dash = (v) => (v === null || v === undefined ? '—' : num(v));

function roleChips(selected, name) {
  return `<div class="role-checkboxes" data-roles="${esc(name)}">${ROLES.map(
    (r) => `<label class="role-checkbox${selected.includes(r) ? ' checked' : ''}">
      <input type="checkbox" value="${r}" ${selected.includes(r) ? 'checked' : ''}>${ROLE_LABELS[r]}</label>`,
  ).join('')}</div>`;
}
function readRoles(el) {
  return [...el.querySelectorAll('[data-roles] input:checked')].map((i) => i.value);
}
function typeSelect(value) {
  return `<select data-tipo aria-label="Tipo de respuesta">${Object.entries(TYPE_LABELS)
    .map(([k, l]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${l}</option>`)
    .join('')}</select>`;
}

export async function render(root, ctx) {
  const st = {
    tab: ctx.params.get('vista') === 'preguntas' ? 'preguntas' : 'revision',
    userId: ctx.params.get('persona') || '',
    range: null, // { preset, from, to, label }
    data: null, // GET /eod/revision
    preguntas: null, // GET /eod/preguntas
    open: new Set(),
    editing: null, // id de la pregunta en edición
    adding: false,
  };
  let rc = null;
  let reqToken = 0;
  let savedTimer;

  root.innerHTML = `
    <div class="crm-page dx-page eq-admin-eod">
      <div data-head></div>
      <div data-controls></div>
      <div data-content>${loading()}</div>
    </div>`;
  const head = root.querySelector('[data-head]');
  const controls = root.querySelector('[data-controls]');
  const content = root.querySelector('[data-content]');

  function drawHead() {
    head.innerHTML = dxHeader({
      eyebrow: 'Reportes',
      title: 'EOD del equipo',
      rangeText: st.tab === 'revision' ? st.range?.label || '' : '',
      actionsHtml: '<span class="save-status" data-saved>Guardado ✓</span>',
    });
  }
  function flashSaved() {
    const el = head.querySelector('[data-saved]');
    if (!el) return;
    el.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('show'), 1300);
  }

  function userSelectHtml() {
    const users = st.data?.usuarios || [];
    return `<select class="dxe-select" aria-label="Filtrar por persona" data-user>
      <option value="">Todas las personas</option>
      ${users.map((u) => `<option value="${esc(u.id)}" ${u.id === st.userId ? 'selected' : ''}>${esc(u.nombre || u.email)}</option>`).join('')}
    </select>`;
  }

  function drawControls() {
    const tabs = dxSeg(TABS, st.tab, { label: 'Vista', name: 'tab' });
    if (st.tab === 'preguntas') {
      controls.innerHTML = `<div class="dx-controls">${tabs}</div>`;
      rc = null;
      return;
    }
    controls.innerHTML = `<div class="dx-controls eq-controls">${tabs}<span data-user-wrap>${userSelectHtml()}</span></div>`;
    rc = rangeControls({
      preset: st.range?.preset || 'month',
      from: st.range?.from || '',
      to: st.range?.to || '',
      onChange: (r) => {
        st.range = r;
        drawHead();
        loadReview();
      },
    });
    rc.el.classList.add('eq-rc-inline');
    controls.querySelector('.eq-controls').appendChild(rc.el);
    if (!st.range) st.range = rc.current();
  }

  // ------------------------------------------------------------ revisión
  async function loadReview() {
    if (!st.range) return;
    const my = ++reqToken;
    rc?.setBusy(true);
    content.querySelector('[data-review]')?.classList.add('dx-dim');
    try {
      const d = await get(`/eod/revision?from=${st.range.from}&to=${st.range.to}`);
      if (my !== reqToken) return;
      st.data = d;
      const wrap = controls.querySelector('[data-user-wrap]');
      if (wrap) wrap.innerHTML = userSelectHtml();
      drawReview();
    } catch (err) {
      if (my !== reqToken) return;
      if (!st.data) content.innerHTML = `<div class="lite-empty">No se pudo cargar la revisión: ${esc(err.message)}</div>`;
      else toast(err.message, { error: true });
    } finally {
      if (my === reqToken) rc?.setBusy(false);
    }
  }

  function setterTable(d) {
    // Preguntas numéricas del setter que no son las 4 conocidas: una columna cada una.
    const extras = d.preguntas.filter((p) => p.tipo === 'numero' && p.roles.includes('setter') && p.activa && !KNOWN.includes(normQ(p.texto)));
    const leader = d.setters.reduce((best, r) => (r.metrics.cash > (best?.metrics.cash ?? 0) ? r : best), null);
    const head = [
      'Setter',
      'EODs',
      'Outbound',
      'Resp. Outbound',
      '% Resp. Outbound',
      'Inbound',
      'Follow ups',
      'Nuevas conv.',
      ...extras.map((p) => p.texto),
      'Propuestas',
      'Links',
      'Agendas',
      'Calificadas',
      '% Conv. → calif.',
      'Show rate',
      'Close rate',
      'Ventas',
      'Cash collected',
    ];
    const rows = d.setters.length
      ? d.setters
          .map((r) => {
            const e = r.eod;
            const m = r.metrics;
            const crown = leader && leader.user.id === r.user.id ? `<span class="dx-person-crown" title="Líder en cash del período">${icons.crown}</span>` : '';
            return `<tr>
              <td class="dx-cell-name">${person(r.user, crown)}</td>
              <td>${num(e.enviados)}</td>
              <td>${dash(e.outbound)}</td>
              <td>${dash(e.respuestasOutbound)}</td>
              <td>${pct(e.pctRespuestaOutbound)}</td>
              <td>${dash(e.inbound)}</td>
              <td>${dash(e.followUps)}</td>
              <td>${dash(e.nuevasConversaciones)}</td>
              ${extras.map((p) => `<td>${dash(e.porPregunta?.[p.id])}</td>`).join('')}
              <td>${num(m.propuestas)}</td>
              <td>${num(m.links)}</td>
              <td>${num(m.agendas)}</td>
              <td>${num(m.calificadas)}</td>
              <td>${pct(e.pctConvCalificada)}</td>
              <td>${pct(m.showRate)}</td>
              <td>${pct(m.closeRate)}</td>
              <td>${num(m.ventas)}</td>
              <td><span class="dx-cash-pill">${esc(money(m.cash))}</span></td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="${head.length}" class="dx-table-empty">No hay setters activos.</td></tr>`;
    return `<div class="dx-card dx-table-card dxe-table-wrap">
      <table class="dx-table"><thead><tr>${head.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }

  function closerTable(d) {
    if (!d.closers.length) return '';
    const head = ['Closer', 'EODs', 'Llamadas', 'Shows', 'No shows', 'Show rate', 'Ventas', 'Close rate', 'Cash collected'];
    return `${dxSectionLabel('Métricas por closer')}
      <div class="dx-card dx-table-card dxe-table-wrap">
        <table class="dx-table"><thead><tr>${head.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>
        ${d.closers
          .map(
            (r) => `<tr>
              <td class="dx-cell-name">${person(r.user)}</td>
              <td>${num(r.enviados)}</td>
              <td>${num(r.metrics.llamadas)}</td>
              <td>${num(r.metrics.shows)}</td>
              <td>${num(r.metrics.noShows)}</td>
              <td>${pct(r.metrics.showRate)}</td>
              <td>${num(r.metrics.ventas)}</td>
              <td>${pct(r.metrics.closeRate)}</td>
              <td><span class="dx-cash-pill">${esc(money(r.metrics.cash))}</span></td>
            </tr>`,
          )
          .join('')}
        </tbody></table>
      </div>`;
  }

  function submissionsHtml(d) {
    const qById = new Map(d.preguntas.map((p) => [p.id, p]));
    const order = new Map(d.preguntas.map((p, i) => [p.id, i]));
    const list = st.userId ? d.envios.filter((e) => e.user_id === st.userId) : d.envios;
    if (!list.length) return dxCard('<p class="dxe-empty">No hay reportes cargados en este rango.</p>');
    return `<div class="dxe-sub-list">${list
      .map((e) => {
        const open = st.open.has(e.id);
        const label = e.nombre || e.email;
        const answers = Object.entries(e.respuestas || {}).sort(([a], [b]) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
        return `<div class="dxe-sub${open ? ' open' : ''}">
          <button type="button" class="dxe-sub-head" aria-expanded="${open}" data-sub="${esc(e.id)}">
            ${avatar(e.user_id, label)}
            <span class="dxe-sub-user">${esc(label)}</span>
            <span class="dxe-sub-date">${esc(fmtDay(e.fecha))}</span>
            <span class="dxe-sub-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>
          </button>
          ${
            open
              ? `<div class="dxe-sub-answers">${
                  answers.length
                    ? answers
                        .map(([qid, v]) => {
                          const q = qById.get(qid);
                          return `<div class="dxe-answer-row"><span class="dxe-answer-label">${esc(q?.texto ?? 'Pregunta eliminada')}${q && !q.activa ? ' <span class="eq-muted">(inactiva)</span>' : ''}</span><span class="dxe-answer-value">${esc(formatAnswer(v, q?.tipo))}</span></div>`;
                        })
                        .join('')
                    : '<p class="dxe-empty">Sin respuestas.</p>'
                }</div>`
              : ''
          }
        </div>`;
      })
      .join('')}</div>`;
  }

  function drawReview() {
    const d = st.data;
    if (!d) return;
    const teamCash = d.setters.reduce((a, r) => a + r.metrics.cash, 0);
    const sum = (f) => d.setters.reduce((a, r) => a + (f(r) || 0), 0);
    const anyEod = d.setters.some((r) => r.eod.enviados > 0);
    const totalEnvios = d.envios.length;
    content.innerHTML = `
      <div data-review>
        <div class="dxe-body">
          ${dxHero({
            label: 'Cash collected del equipo de setters',
            value: money(teamCash),
            noteHtml: `${num(sum((r) => r.metrics.ventas))} ventas · ${num(sum((r) => r.metrics.calificadas))} agendas calificadas · ${num(totalEnvios)} EODs cargados`,
          })}
          ${dxTiles(
            dxTile({ index: 1, tone: 'indigo', icon: icons.calendar, label: 'Agendas', value: num(sum((r) => r.metrics.agendas)) }) +
              dxTile({ index: 2, tone: 'emerald', icon: icons.check, label: 'Calificadas', value: num(sum((r) => r.metrics.calificadas)) }) +
              dxTile({ index: 3, tone: 'peach', icon: icons.chat, label: 'Outbound', value: anyEod ? num(sum((r) => r.eod.outbound)) : '—', sub: 'suma del equipo (EOD)' }) +
              dxTile({ index: 4, tone: 'indigo', icon: icons.users, label: 'Nuevas conversaciones', value: anyEod ? num(sum((r) => r.eod.nuevasConversaciones)) : '—', sub: 'inbound + respuestas a outbound' }) +
              dxTile({ index: 5, tone: 'peach', icon: icons.link, label: 'Propuestas / links', value: `${num(sum((r) => r.metrics.propuestas))} / ${num(sum((r) => r.metrics.links))}`, sub: 'avisos de ManyChat' }),
          )}
        </div>
        ${dxSectionLabel('Métricas por setter')}
        ${setterTable(d)}
        ${closerTable(d)}
        ${dxSectionLabel('Reportes cargados')}
        ${submissionsHtml(d)}
      </div>`;
  }

  function fmtDay(s) {
    const [y, m, dd] = s.split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
  }

  // ------------------------------------------------------------ preguntas
  async function loadQuestions() {
    try {
      st.preguntas = (await get('/eod/preguntas')).preguntas;
      drawQuestions();
    } catch (err) {
      content.innerHTML = `<div class="lite-empty">No se pudieron cargar las preguntas: ${esc(err.message)}</div>`;
    }
  }

  function questionItem(q, i, n) {
    if (st.editing === q.id) {
      return `<div class="sop-item admin-form eod-question-edit eq-q-edit" data-qid="${esc(q.id)}">
        <input data-texto value="${esc(q.texto)}" placeholder="Pregunta" maxlength="300" aria-label="Pregunta">
        ${typeSelect(q.tipo)}
        ${roleChips(q.roles, 'edit')}
        <span class="eq-q-edit-actions">
          <button type="button" data-save>Guardar</button>
          <button type="button" class="btn-secondary" data-cancel>Cancelar</button>
        </span>
      </div>`;
    }
    return `<div class="sop-item eod-question-item${q.activa ? '' : ' inactive'}" data-qid="${esc(q.id)}">
      <span class="eod-question-prompt">${esc(q.texto)}</span>
      <span class="eod-question-meta">${TYPE_LABELS[q.tipo] || q.tipo} · ${q.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}${q.activa ? '' : ' · Inactiva'}</span>
      <span class="sop-item-actions">
        <button type="button" class="sop-edit-btn eq-move" data-move="-1" title="Subir" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="sop-edit-btn eq-move" data-move="1" title="Bajar" aria-label="Bajar" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="sop-edit-btn" data-edit>Editar</button>
        <button type="button" class="sop-delete-btn${q.activa ? '' : ' eq-reactivate'}" data-toggle title="${q.activa ? 'Desactivar' : 'Activar'}" aria-label="${q.activa ? 'Desactivar' : 'Activar'}">${q.activa ? '✕' : '↺'}</button>
      </span>
    </div>`;
  }

  function drawQuestions() {
    const qs = st.preguntas || [];
    content.innerHTML = `
      <p class="eq-hint eq-hint-block">Estas preguntas se le muestran a cada persona en «Mi EOD» según su rol. Desactivar una pregunta la oculta sin borrar lo que ya se respondió.
      Las preguntas <strong>Outbound</strong>, <strong>Respuestas a Outbound</strong>, <strong>Inbound</strong> y <strong>Follow ups</strong> se usan para calcular métricas: si les cambias el nombre, esas métricas quedan en «—».</p>
      <div class="sop-list">${qs.length ? qs.map((q, i) => questionItem(q, i, qs.length)).join('') : '<div class="lite-empty">Todavía no hay preguntas.</div>'}</div>
      ${
        st.adding
          ? `<div class="admin-form eod-question-edit eq-q-edit" data-new>
              <input data-texto placeholder="Pregunta (ej. Outbound)" maxlength="300" aria-label="Pregunta nueva">
              ${typeSelect('numero')}
              ${roleChips(['setter'], 'new')}
              <span class="eq-q-edit-actions">
                <button type="button" data-add-save>Agregar</button>
                <button type="button" class="btn-secondary" data-add-cancel>Cancelar</button>
              </span>
            </div>`
          : '<button type="button" class="add-bubble-btn" data-add>+ Agregar pregunta</button>'
      }`;
    if (st.adding) content.querySelector('[data-new] [data-texto]')?.focus();
    if (st.editing) content.querySelector(`[data-qid="${CSS.escape(st.editing)}"] [data-texto]`)?.focus();
  }

  function replaceQuestion(q) {
    st.preguntas = st.preguntas.map((x) => (x.id === q.id ? q : x));
  }

  // ------------------------------------------------------------ eventos
  const offs = [
    on(controls, 'click', '[data-seg-name="tab"] [data-seg]', (e, el) => {
      if (el.dataset.seg === st.tab) return;
      st.tab = el.dataset.seg;
      ctx.setParams({ vista: st.tab === 'preguntas' ? 'preguntas' : null });
      show();
    }),
    on(controls, 'change', '[data-user]', (e, el) => {
      st.userId = el.value;
      ctx.setParams({ persona: st.userId || null });
      drawReview();
    }),
    on(content, 'click', '[data-sub]', (e, el) => {
      const id = el.dataset.sub;
      if (st.open.has(id)) st.open.delete(id);
      else st.open.add(id);
      drawReview();
    }),
    // roles en chips: el estilo «checked» va en la etiqueta
    on(content, 'change', '[data-roles] input', (e, el) => {
      el.closest('label').classList.toggle('checked', el.checked);
    }),
    on(content, 'click', '[data-add]', () => {
      st.adding = true;
      st.editing = null;
      drawQuestions();
    }),
    on(content, 'click', '[data-add-cancel]', () => {
      st.adding = false;
      drawQuestions();
    }),
    on(content, 'click', '[data-add-save]', async (e, el) => {
      const box = el.closest('[data-new]');
      const texto = box.querySelector('[data-texto]').value.trim();
      const tipo = box.querySelector('[data-tipo]').value;
      const roles = readRoles(box);
      if (!texto) return toast('Escribe la pregunta', { error: true });
      if (!roles.length) return toast('Elige al menos un rol', { error: true });
      el.disabled = true;
      try {
        const r = await post('/eod/preguntas', { texto, tipo, roles });
        st.preguntas.push(r.pregunta);
        st.adding = false;
        drawQuestions();
        flashSaved();
      } catch (err) {
        el.disabled = false;
        toast(err.message, { error: true });
      }
    }),
    on(content, 'click', '[data-edit]', (e, el) => {
      st.editing = el.closest('[data-qid]').dataset.qid;
      st.adding = false;
      drawQuestions();
    }),
    on(content, 'click', '[data-cancel]', () => {
      st.editing = null;
      drawQuestions();
    }),
    on(content, 'click', '[data-save]', async (e, el) => {
      const box = el.closest('[data-qid]');
      const id = box.dataset.qid;
      const q = st.preguntas.find((x) => x.id === id);
      const texto = box.querySelector('[data-texto]').value.trim();
      const tipo = box.querySelector('[data-tipo]').value;
      const roles = readRoles(box);
      if (!texto) return toast('Escribe la pregunta', { error: true });
      if (!roles.length) return toast('Elige al menos un rol', { error: true });
      const fields = {};
      if (texto !== q.texto) fields.texto = texto;
      if (tipo !== q.tipo) fields.tipo = tipo;
      if (roles.join(',') !== q.roles.join(',')) fields.roles = roles;
      if (!Object.keys(fields).length) {
        st.editing = null;
        return drawQuestions();
      }
      el.disabled = true;
      try {
        const r = await patch(`/eod/preguntas/${id}`, fields);
        replaceQuestion(r.pregunta);
        st.editing = null;
        drawQuestions();
        flashSaved();
      } catch (err) {
        el.disabled = false;
        toast(err.message, { error: true });
      }
    }),
    on(content, 'keydown', '.eq-q-edit [data-texto]', (e, el) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.closest('.eq-q-edit').querySelector('[data-save], [data-add-save]')?.click();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        el.closest('.eq-q-edit').querySelector('[data-cancel], [data-add-cancel]')?.click();
      }
    }),
    on(content, 'click', '[data-toggle]', async (e, el) => {
      const id = el.closest('[data-qid]').dataset.qid;
      const q = st.preguntas.find((x) => x.id === id);
      const prev = st.preguntas;
      replaceQuestion({ ...q, activa: !q.activa });
      drawQuestions();
      try {
        const r = await patch(`/eod/preguntas/${id}`, { activa: !q.activa });
        replaceQuestion(r.pregunta);
        flashSaved();
      } catch (err) {
        st.preguntas = prev;
        drawQuestions();
        toast(err.message, { error: true });
      }
    }),
    on(content, 'click', '[data-move]', async (e, el) => {
      const id = el.closest('[data-qid]').dataset.qid;
      const i = st.preguntas.findIndex((x) => x.id === id);
      const j = i + Number(el.dataset.move);
      if (i < 0 || j < 0 || j >= st.preguntas.length) return;
      const prev = st.preguntas;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      st.preguntas = next;
      drawQuestions();
      content.querySelector(`[data-qid="${CSS.escape(id)}"] [data-move="${el.dataset.move}"]:not([disabled])`)?.focus();
      try {
        const r = await put('/eod/preguntas/orden', { ids: next.map((x) => x.id) });
        st.preguntas = r.preguntas;
        flashSaved();
      } catch (err) {
        st.preguntas = prev;
        drawQuestions();
        toast(err.message, { error: true });
      }
    }),
  ];

  function show() {
    drawControls();
    drawHead();
    if (st.tab === 'preguntas') {
      if (st.preguntas) drawQuestions();
      else {
        content.innerHTML = loading();
        loadQuestions();
      }
    } else if (st.data) {
      drawReview();
      loadReview();
    } else {
      content.innerHTML = loading();
      loadReview();
    }
  }

  show();
  return () => {
    clearTimeout(savedTimer);
    offs.forEach((off) => off());
  };
}

