// Pantalla «Metas» (/metas), como GoalsPageClient de la versión completa: metas por persona
// y período (semana lunes–domingo o mes) con barra de progreso en vivo.
// Admin las edita (clic en «Meta: …») y ve a todo el equipo; setter/closer solo las
// suyas (el servidor ya filtra).
import { get, put } from '../core/api.js';
import { addDays, todayStr, weekStart } from '../core/dates.js';
import { colorOf, esc, icons, initialsOf, money, num, on } from '../core/dom.js';
import { dxHeader, dxHero, dxSectionLabel, dxSeg, dxTile, dxTiles, loading, toast } from '../core/ui.js';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtShort(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
}
function addMonths(s, n) {
  const [y, m] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
const firstOfMonth = (s) => `${s.slice(0, 7)}-01`;
const tone = (p) => (p >= 100 ? 'tone-emerald' : p >= 50 ? 'tone-indigo' : 'tone-peach');
const fmtVal = (m, v) => (m.money ? money(v) : num(v, 2));

export async function render(root, ctx) {
  const st = {
    periodo: ctx.params.get('periodo') === 'mes' ? 'mes' : 'semana',
    inicio: '',
    data: null,
    editing: null, // `${userId}:${metrica}`
    loading: true,
  };
  st.inicio = st.periodo === 'semana' ? weekStart(todayStr()) : firstOfMonth(todayStr());
  let token = 0;
  let savedTimer;

  root.innerHTML = `
    <div class="crm-page dx-page eq-metas">
      <div data-head></div>
      <div class="dx-controls" data-controls></div>
      <div data-content>${loading()}</div>
    </div>`;
  const head = root.querySelector('[data-head]');
  const controls = root.querySelector('[data-controls]');
  const content = root.querySelector('[data-content]');

  const fin = () => (st.periodo === 'semana' ? addDays(st.inicio, 6) : addDays(addMonths(st.inicio, 1), -1));
  const periodLabel = () => {
    if (st.periodo === 'semana') return `Semana del ${fmtShort(st.inicio)} al ${fmtShort(fin())}`;
    const [y, m] = st.inicio.split('-').map(Number);
    return `${MONTHS[m - 1]} de ${y}`;
  };

  function drawTop() {
    const label = periodLabel();
    head.innerHTML = dxHeader({ eyebrow: 'Reportes', title: 'Metas', rangeText: label });
    controls.innerHTML = `
      ${dxSeg(
        [
          { key: 'semana', label: 'Semanal' },
          { key: 'mes', label: 'Mensual' },
        ],
        st.periodo,
        { label: 'Tipo de período', name: 'periodo' },
      )}
      <div class="dx-stepper">
        <button type="button" aria-label="Período anterior" data-step="-1">‹</button>
        <span class="dx-stepper-label">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</span>
        <button type="button" aria-label="Período siguiente" data-step="1">›</button>
      </div>
      ${st.loading ? '<span class="dx-loading-dot">Cargando…</span>' : ''}
      <span class="dx-loading-dot dx-saved" data-saved hidden>Guardado ✓</span>`;
  }

  async function load() {
    const my = ++token;
    st.loading = true;
    st.editing = null;
    drawTop();
    content.querySelector('[data-body]')?.classList.add('dx-dim');
    try {
      const d = await get(`/metas?periodo=${st.periodo}&inicio=${st.inicio}`);
      if (my !== token) return;
      st.data = d;
      st.inicio = d.inicio;
    } catch (err) {
      if (my !== token) return;
      if (!st.data) content.innerHTML = `<div class="lite-empty">No se pudieron cargar las metas: ${esc(err.message)}</div>`;
      else toast(err.message, { error: true });
    } finally {
      if (my === token) {
        st.loading = false;
        drawTop();
        if (st.data) drawContent();
      }
    }
  }

  function goalCell(fila, m) {
    const key = `${fila.user.id}:${m.metrica}`;
    const hasMeta = m.meta !== null && m.meta > 0;
    const p = hasMeta ? m.pct ?? 0 : null;
    const t = hasMeta ? tone(p) : '';
    const targetLabel = `Meta: ${m.meta === null ? 'sin definir' : fmtVal(m, m.meta)}`;
    let target;
    if (!st.data.puedeEditar) target = `<span class="goals-cell-target-readonly">${esc(targetLabel)}</span>`;
    else if (st.editing === key)
      target = `<input type="number" min="0" step="any" class="dx-goal-input" data-goal-input="${esc(key)}" value="${m.meta === null ? '' : esc(String(m.meta))}" aria-label="Meta de ${esc(m.label)}" placeholder="Vacío = sin meta">`;
    else target = `<button type="button" class="dx-goal-edit" data-goal="${esc(key)}" title="Editar meta">${esc(targetLabel)}</button>`;
    return `
      <div class="dx-goal">
        <div class="dx-goal-top">
          <span class="dx-goal-label">${esc(m.label)}</span>
          ${hasMeta ? `<span class="dx-goal-pct ${t}">${p.toFixed(0)}%</span>` : ''}
        </div>
        <div class="dx-goal-track"><div class="dx-goal-fill ${t}" style="width:${hasMeta ? Math.min(p, 100) : 0}%"></div></div>
        <div class="dx-goal-bottom">
          <span class="dx-goal-actual">${esc(fmtVal(m, m.actual))}</span>
          <span class="dx-goal-target">${target}</span>
        </div>
      </div>`;
  }

  function personCard(fila, i) {
    const label = fila.user.nombre || fila.user.email;
    const withMeta = fila.metricas.filter((m) => m.meta !== null && m.meta > 0);
    const avg = withMeta.length ? withMeta.reduce((a, m) => a + Math.min(100, m.pct ?? 0), 0) / withMeta.length : null;
    return `
      <div class="goals-person-card" style="--i:${i}">
        <div class="dx-person-head">
          <span class="dx-person">
            <span class="dx-person-avatar" style="background:${colorOf(fila.user.id)}">${esc(initialsOf(label))}</span>
            <span class="goals-person-name">${esc(label)}</span>
          </span>
          ${avg !== null ? `<span class="dx-goal-pct ${tone(avg)}">${avg.toFixed(0)}%</span>` : ''}
        </div>
        ${fila.metricas.map((m) => goalCell(fila, m)).join('')}
      </div>`;
  }

  function drawContent() {
    const d = st.data;
    const setters = d.filas.filter((f) => f.rol === 'setter');
    const closers = d.filas.filter((f) => f.rol === 'closer');
    const roles = ctx.user.roles;
    const showSetters = ctx.isAdmin || roles.includes('setter');
    const showClosers = ctx.isAdmin || roles.includes('closer');
    const all = d.filas.flatMap((f) => f.metricas);
    const withMeta = all.filter((m) => m.meta !== null && m.meta > 0);
    const avg = withMeta.length ? withMeta.reduce((a, m) => a + Math.min(100, m.pct ?? 0), 0) / withMeta.length : null;
    const met = withMeta.filter((m) => (m.pct ?? 0) >= 100).length;
    const onTrack = withMeta.filter((m) => (m.pct ?? 0) >= 50 && (m.pct ?? 0) < 100).length;
    const behind = withMeta.filter((m) => (m.pct ?? 0) < 50).length;

    const section = (title, list, empty) =>
      `${dxSectionLabel(title)}
       <div class="goals-grid">${list.length ? list.map(personCard).join('') : `<p class="crm-notes-empty">${esc(empty)}</p>`}</div>`;

    content.innerHTML = `
      <div data-body>
        ${dxHero({
          label: 'Cumplimiento de metas',
          value: avg === null ? '—' : `${avg.toFixed(0)}%`,
          progress: avg,
          ring: avg,
          ringLabel: 'promedio',
          noteHtml: withMeta.length
            ? `${met} de ${withMeta.length} metas cumplidas`
            : d.puedeEditar
              ? 'Todavía no hay metas en este período. Toca «Meta: sin definir» en cada persona para ponerla.'
              : 'Todavía no tienes metas en este período.',
        })}
        ${dxTiles(
          dxTile({ index: 1, tone: 'emerald', icon: icons.check, label: 'Cumplidas', value: num(met), sub: '100% o más' }) +
            dxTile({ index: 2, tone: 'indigo', icon: icons.trend, label: 'En camino', value: num(onTrack), sub: 'entre 50% y 99%' }) +
            dxTile({ index: 3, tone: 'peach', icon: icons.target, label: 'Por debajo', value: num(behind), sub: 'menos de 50%' }) +
            dxTile({ index: 4, tone: 'indigo', icon: icons.target, label: 'Sin meta definida', value: num(all.length - withMeta.length), sub: 'metas en blanco' }),
        )}
        ${showSetters ? section('Setters', setters, 'No hay setters activos.') : ''}
        ${showClosers ? section('Closers', closers, 'No hay closers activos.') : ''}
        <p class="eq-hint">Outbound sale de los EOD cargados; el resto, de Ventas y de los avisos de ManyChat. Cada período tiene sus propias metas.</p>
      </div>`;
    if (st.editing) {
      const input = content.querySelector(`[data-goal-input="${CSS.escape(st.editing)}"]`);
      input?.focus();
      input?.select();
    }
  }

  function flashSaved() {
    const el = controls.querySelector('[data-saved]');
    if (!el) return;
    el.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (el.hidden = true), 1500);
  }

  async function commit(input, cancel = false) {
    const key = input.dataset.goalInput;
    if (st.editing !== key) return;
    st.editing = null;
    const [userId, metrica] = key.split(':');
    const fila = st.data.filas.find((f) => f.user.id === userId && f.metricas.some((m) => m.metrica === metrica));
    const m = fila?.metricas.find((x) => x.metrica === metrica);
    const raw = input.value.trim();
    const next = raw === '' ? null : Number(raw);
    if (cancel || !m || next === m.meta || (next !== null && (!Number.isFinite(next) || next < 0))) {
      if (!cancel && next !== null && (!Number.isFinite(next) || next < 0)) toast('La meta tiene que ser un número de 0 en adelante', { error: true });
      return drawContent();
    }
    const prev = { meta: m.meta, pct: m.pct };
    m.meta = next;
    m.pct = next && next > 0 ? (m.actual / next) * 100 : null;
    drawContent();
    try {
      await put('/metas', { userId, metrica, periodo: st.periodo, inicio: st.inicio, valor: next === null ? '' : next });
      flashSaved();
    } catch (err) {
      m.meta = prev.meta;
      m.pct = prev.pct;
      drawContent();
      toast(err.message, { error: true });
    }
  }

  const offs = [
    on(controls, 'click', '[data-seg-name="periodo"] [data-seg]', (e, el) => {
      if (el.dataset.seg === st.periodo) return;
      st.periodo = el.dataset.seg;
      st.inicio = st.periodo === 'semana' ? weekStart(todayStr()) : firstOfMonth(todayStr());
      ctx.setParams({ periodo: st.periodo === 'mes' ? 'mes' : null });
      load();
    }),
    on(controls, 'click', '[data-step]', (e, el) => {
      const n = Number(el.dataset.step);
      st.inicio = st.periodo === 'semana' ? addDays(st.inicio, 7 * n) : addMonths(st.inicio, n);
      load();
    }),
    on(content, 'click', '[data-goal]', (e, el) => {
      st.editing = el.dataset.goal;
      drawContent();
    }),
    on(content, 'keydown', '[data-goal-input]', (e, el) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commit(el, true);
      }
    }),
  ];
  // blur no burbujea: se escucha en captura.
  const onBlur = (e) => {
    if (e.target instanceof Element && e.target.matches('[data-goal-input]')) commit(e.target);
  };
  content.addEventListener('blur', onBlur, true);

  await load();
  return () => {
    clearTimeout(savedTimer);
    content.removeEventListener('blur', onBlur, true);
    offs.forEach((off) => off());
  };
}
