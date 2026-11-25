// Marco de la app: barra lateral (grupos, pastilla que se
// desliza, colapsable a íconos, cajón en el celular) + área de contenido.
import { PRODUCT } from './brand.js';
import { post } from './api.js';
import { colorOf, esc, h, icons, initialsOf } from './dom.js';
import { canSee, GROUPS, PAGES } from './pages.js';
import { sidePanel, toast } from './ui.js';

const ROLE_LABELS = { admin: 'Admin', setter: 'Setter', closer: 'Closer', coach: 'Coach' };
const COLLAPSE_KEY = 'ago-sidebar-collapsed';

function storageGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* sin almacenamiento */
  }
}

export function renderShell(app, { user, negocio, onNavigate, onLogout }) {
  const groups = GROUPS.map((g) => ({ label: g, links: PAGES.filter((p) => p.group === g && canSee(p, user)) })).filter((g) => g.links.length);
  const collapsed = storageGet(COLLAPSE_KEY) === '1';
  const brand = esc(negocio || PRODUCT);
  app.innerHTML = '';
  const shell = h(`
    <div class="app-shell">
      <div class="mobile-topbar">
        <button type="button" class="mobile-topbar-toggle" aria-label="Abrir menú">${icons.menu}</button>
        <span class="mobile-topbar-brand">${brand}<span>OS</span></span>
      </div>
      <div class="sidebar-backdrop"></div>
      <aside class="sidebar${collapsed ? ' collapsed' : ''}">
        <div class="sidebar-top">
          <div class="sidebar-brand">
            <span class="sidebar-brand-name">${brand}</span>
            <span class="sidebar-brand-badge">OS</span>
          </div>
          <button type="button" class="sidebar-collapse-btn" title="Minimizar menú">${icons.chevronsLeft}</button>
          <button type="button" class="sidebar-close-btn" aria-label="Cerrar menú">${icons.close}</button>
        </div>
        <nav class="sidebar-nav">
          ${groups
            .map(
              (g) => `
            <div class="sidebar-group">
              <span class="sidebar-group-label">${esc(g.label)}</span>
              ${g.links
                .map(
                  (l) => `<a class="sidebar-link" href="${l.path}" data-link title="${collapsed ? esc(l.title) : ''}">${l.icon}<span class="sidebar-link-label">${esc(l.title)}</span></a>`,
                )
                .join('')}
            </div>`,
            )
            .join('')}
        </nav>
        <div class="sidebar-user">
          <button type="button" class="sidebar-user-identity" title="Mi cuenta">
            <div class="sidebar-user-avatar" style="background:${colorOf(user.id)}">${esc(initialsOf(user.email))}</div>
            <div class="sidebar-user-info">
              <span class="sidebar-user-email">${esc(user.nombre || user.email)}</span>
              <span class="sidebar-user-role">${esc(user.roles.map((r) => ROLE_LABELS[r] || r).join(' · '))}</span>
            </div>
          </button>
          <button type="button" class="sidebar-logout" title="Cerrar sesión">${icons.power}</button>
        </div>
      </aside>
      <main class="app-main"></main>
    </div>`);
  app.appendChild(shell);

  const aside = app.querySelector('.sidebar');
  const backdrop = app.querySelector('.sidebar-backdrop');
  const main = app.querySelector('.app-main');
  const closeMobile = () => {
    aside.classList.remove('mobile-open');
    backdrop.classList.remove('show');
  };

  app.querySelector('.mobile-topbar-toggle').onclick = () => {
    aside.classList.add('mobile-open');
    backdrop.classList.add('show');
  };
  backdrop.onclick = closeMobile;
  app.querySelector('.sidebar-close-btn').onclick = closeMobile;
  app.querySelector('.sidebar-collapse-btn').onclick = () => {
    const now = !aside.classList.contains('collapsed');
    aside.classList.toggle('collapsed', now);
    storageSet(COLLAPSE_KEY, now ? '1' : '0');
    aside.querySelectorAll('.sidebar-link').forEach((a) => (a.title = now ? a.textContent.trim() : ''));
  };
  app.querySelector('.sidebar-logout').onclick = onLogout;
  app.querySelector('.sidebar-user-identity').onclick = () => openAccount(user);
  aside.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    closeMobile();
    onNavigate(a.getAttribute('href'));
  });

  return {
    main,
    setActive(path) {
      aside.querySelectorAll('.sidebar-link').forEach((a) => {
        const href = a.getAttribute('href');
        a.classList.toggle('active', path === href || path.startsWith(`${href}/`));
      });
    },
  };
}

function openAccount(user) {
  const p = sidePanel('Mi cuenta');
  p.body.innerHTML = `
    <div class="crm-field"><span class="crm-field-label">Nombre</span><span class="crm-field-value">${esc(user.nombre)}</span></div>
    <div class="crm-field"><span class="crm-field-label">Correo</span><span class="crm-field-value">${esc(user.email)}</span></div>
    <div class="crm-field"><span class="crm-field-label">Roles</span><span class="crm-field-value">${esc(user.roles.map((r) => ROLE_LABELS[r] || r).join(' · '))}</span></div>
    <div class="lite-section-title">Cambiar contraseña</div>
    <form class="lite-form" novalidate>
      <div class="crm-field"><label class="crm-field-label" for="pw-a">Contraseña actual</label><input id="pw-a" name="actual" type="password" autocomplete="current-password" required></div>
      <div class="crm-field"><label class="crm-field-label" for="pw-n">Contraseña nueva (mínimo 8)</label><input id="pw-n" name="nueva" type="password" autocomplete="new-password" required></div>
      <p class="lite-error" role="alert"></p>
      <div class="lite-actions"><button type="submit" class="crm-create-btn">Guardar contraseña</button></div>
    </form>`;
  const form = p.body.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.lite-error');
    const btn = form.querySelector('button');
    err.textContent = '';
    btn.disabled = true;
    try {
      await post('/auth/password', Object.fromEntries(new FormData(form)));
      toast('Contraseña cambiada');
      p.close();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}
