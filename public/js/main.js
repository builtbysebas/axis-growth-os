// Arranque de la app: sesión → marco con barra lateral → pantalla según la ruta.
import { PRODUCT, PRODUCT_BADGE, PRODUCT_MARK } from './core/brand.js';
import { get, post, setUnauthorizedHandler } from './core/api.js';
import { setTimeZone } from './core/dates.js';
import { applyTheme } from './core/theme.js';
import { esc, h } from './core/dom.js';
import { initFx } from './core/fx.js';
import { canSee, defaultPath, PAGES } from './core/pages.js';
import { renderShell } from './core/shell.js';
import { waveText } from './core/ui.js';

const app = document.getElementById('app');
const state = { user: null, ajustes: null, shell: null, cleanup: null, renderToken: 0 };

initFx();

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  state.shell = null;
  renderLogin('Tu sesión venció. Vuelve a entrar.');
});

// ---------------------------------------------------------------- navegación
function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else if (path !== location.pathname + location.search) history.pushState({}, '', path);
  route();
}
window.addEventListener('popstate', () => state.user && route());

// Links internos en las páginas: <a href="/x" data-link>
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-link]');
  if (!a || a.closest('.sidebar') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

async function route() {
  const user = state.user;
  if (!user) return;
  let page = PAGES.find((p) => p.path === location.pathname);
  if (!page || !canSee(page, user)) {
    navigate(defaultPath(user), { replace: true });
    return;
  }
  if (!state.shell) {
    state.shell = renderShell(app, {
      user,
      negocio: state.ajustes?.negocio,
      onNavigate: (p) => navigate(p),
      onLogout: logout,
    });
  }
  state.shell.setActive(location.pathname);
  document.title = `${page.title} · ${state.ajustes?.negocio || PRODUCT}`;
  const token = ++state.renderToken;
  if (state.cleanup) {
    try {
      state.cleanup();
    } catch {
      /* nada */
    }
    state.cleanup = null;
  }
  const main = state.shell.main;
  document.documentElement.setAttribute('data-nav-pending', '');
  try {
    const mod = await page.load();
    if (token !== state.renderToken) return;
    main.innerHTML = '';
    const root = h('<div class="lite-page"></div>');
    main.appendChild(root);
    const ctx = {
      user,
      page,
      navigate,
      ajustes: state.ajustes,
      params: new URLSearchParams(location.search),
      setParams(obj) {
        const p = new URLSearchParams(location.search);
        for (const [k, v] of Object.entries(obj)) {
          if (v === null || v === undefined || v === '') p.delete(k);
          else p.set(k, v);
        }
        const s = p.toString();
        history.replaceState({}, '', `${location.pathname}${s ? `?${s}` : ''}`);
      },
      isAdmin: user.roles.includes('admin'),
      has: (r) => user.roles.includes(r) || user.roles.includes('admin'),
      reloadAjustes: loadAjustes,
    };
    const cleanup = await mod.render(root, ctx);
    // Pasada la animación de entrada, la página queda «asentada» (ver lite.css).
    setTimeout(() => root.classList.add('lite-settled'), 900);
    if (token !== state.renderToken) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    if (typeof cleanup === 'function') state.cleanup = cleanup;
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    if (token === state.renderToken) main.innerHTML = `<div class="lite-empty">No se pudo abrir esta pantalla: ${esc(err.message)}</div>`;
  } finally {
    if (token === state.renderToken) document.documentElement.removeAttribute('data-nav-pending');
  }
}

async function loadAjustes() {
  try {
    state.ajustes = await get('/ajustes');
    setTimeZone(state.ajustes.zona);
    applyTheme(state.ajustes.color);
  } catch {
    state.ajustes = { zona: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima', negocio: '', metaCash: 10000 };
  }
  return state.ajustes;
}

async function enter(user) {
  state.user = user;
  state.shell = null;
  await loadAjustes();
  if (location.pathname === '/' || location.pathname === '/login') navigate(defaultPath(user), { replace: true });
  else route();
}

async function logout() {
  try {
    await post('/auth/logout');
  } catch {
    /* igual salimos */
  }
  state.user = null;
  state.shell = null;
  history.replaceState({}, '', '/');
  renderLogin();
}

// ---------------------------------------------------------------- acceso
function authPage({ title, note = '', fields, button, onSubmit, alt = null, remember = false }) {
  app.innerHTML = '';
  const el = h(`
    <div class="login-page">
      <div class="login-brand"><span class="login-brand-mark">${esc(PRODUCT_MARK)}</span><span class="login-brand-name">Axis<span class="login-brand-badge">${esc(PRODUCT_BADGE)}</span></span></div>
      <form novalidate>
        ${title ? `<p class="login-setup-note"><strong>${esc(title)}</strong>${note ? `<br>${esc(note)}` : ''}</p>` : ''}
        ${fields
          .map(
            (f) => `<label for="f-${f.name}">${esc(f.label)}</label>
          <input id="f-${f.name}" name="${f.name}" type="${f.type || 'text'}" autocomplete="${f.auto || 'off'}" required>`,
          )
          .join('')}
        ${remember ? '<label class="login-remember"><input type="checkbox" name="remember"> Recordarme por 30 días</label>' : ''}
        <p class="login-error" role="alert" hidden></p>
        <button type="submit">${waveText(button)}</button>
      </form>
      ${alt ? `<button type="button" class="login-alt">${esc(alt.label)}</button>` : ''}
    </div>`);
  app.appendChild(el);
  const form = el.querySelector('form');
  const err = form.querySelector('.login-error');
  form.querySelector('input')?.focus();
  if (alt) el.querySelector('.login-alt').onclick = alt.onClick;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    err.hidden = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      data.remember = !!form.querySelector('[name=remember]')?.checked;
      await onSubmit(data);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

function renderLogin(notice = '') {
  authPage({
    title: notice,
    fields: [
      { name: 'email', label: 'Correo', type: 'email', auto: 'username' },
      { name: 'password', label: 'Contraseña', type: 'password', auto: 'current-password' },
    ],
    button: 'Entrar',
    remember: true,
    onSubmit: async (v) => enter((await post('/auth/login', v)).user),
  });
}

function renderSetup() {
  authPage({
    title: `Bienvenido a ${PRODUCT} 👋`,
    note: 'Crea la cuenta de administrador de tu negocio. Solo se hace una vez.',
    fields: [
      { name: 'negocio', label: 'Nombre de tu negocio', auto: 'organization' },
      { name: 'nombre', label: 'Tu nombre', auto: 'name' },
      { name: 'email', label: 'Correo', type: 'email', auto: 'email' },
      { name: 'password', label: 'Contraseña (mínimo 8)', type: 'password', auto: 'new-password' },
    ],
    button: 'Crear y entrar',
    alt: { label: 'Ya tengo cuenta: iniciar sesión', onClick: () => renderLogin() },
    onSubmit: async (v) => enter((await post('/setup', { ...v, zona: Intl.DateTimeFormat().resolvedOptions().timeZone })).user),
  });
}

function renderMessage(title, text) {
  app.innerHTML = '';
  app.appendChild(
    h(`<div class="login-page"><div class="login-brand"><span class="login-brand-mark">${esc(PRODUCT_MARK)}</span><span class="login-brand-name">Axis<span class="login-brand-badge">${esc(PRODUCT_BADGE)}</span></span></div>
      <form><p class="login-setup-note"><strong>${esc(title)}</strong><br>${esc(text)}</p></form></div>`),
  );
}

async function boot() {
  // Con sesión abierta se entra directo; si no, se pregunta el estado.
  try {
    const { user } = await get('/auth/me');
    return enter(user);
  } catch {
    /* sin sesión */
  }
  let status;
  try {
    status = await get('/status');
  } catch (err) {
    return renderMessage('No se pudo abrir la app', err.message);
  }
  if (status.color) applyTheme(status.color);
  if (!status.connected) return renderMessage('Falta conectar la base de datos', status.reason || '');
  if (status.needsAdmin) return renderSetup();
  renderLogin();
}

boot();
