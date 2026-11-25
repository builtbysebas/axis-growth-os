// Pantalla «Usuarios» (/admin/usuarios, admin), como UsersPageClient de la versión completa:
// tabla con avatar, roles y estado; crear cuenta (con contraseña generada),
// editar nombre/correo/roles, cambiar contraseña y activar/desactivar.
// Usa las rutas de core: GET/POST/PATCH /usuarios.
import { get, patch, post } from '../core/api.js';
import { colorOf, esc, initialsOf, norm, on } from '../core/dom.js';
import { confirmDialog, createButton, expandableSearch, loading, sidePanel, toast } from '../core/ui.js';

const ROLES = ['admin', 'setter', 'closer', 'coach'];
const ROLE_LABELS = { admin: 'Admin', setter: 'Setter', closer: 'Closer', coach: 'Coach' };

/** Contraseña fácil de dictar: sin letras/números que se confundan. */
export function generatePassword(len = 12) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      ta.remove();
    }
  }
  toast('Copiado ✓');
}

function roleChips(selected, { lockAdmin = false } = {}) {
  return `<div class="role-checkboxes" data-roles>${ROLES.map((r) => {
    const on = selected.includes(r);
    const locked = lockAdmin && r === 'admin' && on;
    return `<label class="role-checkbox${on ? ' checked' : ''}${locked ? ' eq-locked' : ''}" ${locked ? 'title="No te puedes quitar el rol de admin a ti misma"' : ''}>
      <input type="checkbox" value="${r}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>${ROLE_LABELS[r]}</label>`;
  }).join('')}</div>`;
}
const readRoles = (el) => [...el.querySelectorAll('[data-roles] input:checked')].map((i) => i.value);

function passwordField(name, label) {
  return `
    <div class="crm-field">
      <label class="crm-field-label" for="eq-${name}">${esc(label)}</label>
      <div class="lite-copyrow">
        <input id="eq-${name}" name="${name}" type="text" autocomplete="new-password" minlength="8" spellcheck="false" placeholder="Mínimo 8 caracteres">
        <button type="button" class="btn-secondary" data-generate="${name}">Generar</button>
      </div>
    </div>`;
}

export async function render(root, ctx) {
  const st = { users: [], search: '' };

  root.innerHTML = `
    <div class="crm-page dx-page eq-users">
      <div class="crm-toolbar">
        <div>
          <span class="crm-eyebrow">Equipo</span>
          <h1>Usuarios</h1>
        </div>
        <div class="crm-toolbar-actions" data-actions>
          <span class="save-status" data-saved>Guardado ✓</span>
          ${createButton('Crear', 'data-create')}
        </div>
      </div>
      <div data-table>${loading()}</div>
    </div>`;
  const table = root.querySelector('[data-table]');
  const actions = root.querySelector('[data-actions]');
  actions.prepend(
    expandableSearch({
      placeholder: 'Buscar nombre o correo…',
      width: 300,
      onInput: (v) => {
        st.search = v;
        drawTable();
      },
    }),
  );
  let savedTimer;
  function flashSaved() {
    const el = actions.querySelector('[data-saved]');
    el.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('show'), 1300);
  }

  function drawTable() {
    const q = norm(st.search.trim());
    const list = q ? st.users.filter((u) => norm(u.nombre).includes(q) || norm(u.email).includes(q)) : st.users;
    table.innerHTML = `
      <div class="users-table-wrap">
        <table class="users-table">
          <thead><tr><th>Usuario</th><th>Roles</th><th>Estado</th></tr></thead>
          <tbody>
            ${list
              .map(
                (u) => `<tr data-user="${esc(u.id)}" class="${u.activo ? '' : 'inactive'}" tabindex="0">
                  <td>
                    <span class="users-table-identity">
                      <span class="crm-chip-avatar" style="background:${colorOf(u.id)}">${esc(initialsOf(u.nombre || u.email))}</span>
                      <span>
                        <span class="users-table-name">${esc(u.nombre || u.email)}${u.id === ctx.user.id ? ' <span class="eq-muted">(tú)</span>' : ''}</span>
                        <span class="users-table-email">${esc(u.email)}</span>
                      </span>
                    </span>
                  </td>
                  <td><span class="role-badges">${u.roles.map((r) => `<span class="role-badge">${esc(ROLE_LABELS[r] || r)}</span>`).join('')}</span></td>
                  <td><span class="users-status${u.activo ? '' : ' inactive'}">${u.activo ? 'Activo' : 'Desactivado'}</span></td>
                </tr>`,
              )
              .join('')}
            ${list.length ? '' : `<tr><td colspan="3" class="clients-table-empty">${st.users.length ? 'Nadie coincide con la búsqueda.' : 'Todavía no hay usuarios.'}</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  async function load() {
    try {
      st.users = (await get('/usuarios')).usuarios;
      drawTable();
    } catch (err) {
      table.innerHTML = `<div class="lite-empty">No se pudieron cargar los usuarios: ${esc(err.message)}</div>`;
    }
  }

  function upsertLocal(u) {
    const i = st.users.findIndex((x) => x.id === u.id);
    if (i >= 0) st.users[i] = u;
    else st.users.unshift(u);
    drawTable();
  }

  // ------------------------------------------------------------ crear
  function openCreate() {
    const panel = sidePanel('Nueva cuenta');
    panel.body.innerHTML = `
      <form class="lite-form" novalidate>
        <div class="crm-field">
          <label class="crm-field-label" for="eq-nombre">Nombre</label>
          <input id="eq-nombre" name="nombre" autocomplete="off" maxlength="120" required>
        </div>
        <div class="crm-field">
          <label class="crm-field-label" for="eq-email">Correo</label>
          <input id="eq-email" name="email" type="email" autocomplete="off" required>
        </div>
        ${passwordField('password', 'Contraseña temporal')}
        <div class="crm-field">
          <span class="crm-field-label">Roles (puedes elegir varios)</span>
          ${roleChips(['setter'])}
        </div>
        <div class="lite-error" data-error></div>
        <div class="lite-actions"><button type="submit" class="crm-create-btn">Crear cuenta</button></div>
      </form>`;
    const form = panel.body.querySelector('form');
    form.password.value = generatePassword();
    form.nombre.focus();
    form.querySelector('[data-generate]').addEventListener('click', () => {
      form.password.value = generatePassword();
      form.password.focus();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('[data-error]');
      const nombre = form.nombre.value.trim();
      const email = form.email.value.trim();
      const password = form.password.value;
      const roles = readRoles(form);
      err.textContent = '';
      if (!nombre || !email) return (err.textContent = 'Completa el nombre y el correo.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return (err.textContent = 'El correo no parece válido.');
      if (password.length < 8) return (err.textContent = 'La contraseña debe tener al menos 8 caracteres.');
      if (!roles.length) return (err.textContent = 'Elige al menos un rol.');
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const r = await post('/usuarios', { nombre, email, password, roles });
        upsertLocal(r.usuario);
        flashSaved();
        showCredentials(panel, r.usuario, password);
      } catch (e2) {
        err.textContent = e2.message;
        btn.disabled = false;
      }
    });
  }

  function showCredentials(panel, u, password) {
    const text = `Tu cuenta de ${ctx.ajustes?.negocio || 'tu equipo'}:\nEntra en ${location.origin}\nCorreo: ${u.email}\nContraseña: ${password}\n(Cámbiala apenas entres, desde «Mi cuenta».)`;
    panel.setTitle('Cuenta creada');
    panel.body.innerHTML = `
      <p class="eq-hint">Pásale estos datos a <strong>${esc(u.nombre)}</strong> por un mensaje privado. La contraseña no se vuelve a mostrar.</p>
      <pre class="eq-code">${esc(text)}</pre>
      <div class="lite-actions">
        <button type="button" class="crm-create-btn" data-copy-cred>Copiar datos de acceso</button>
        <button type="button" class="btn-secondary" data-close>Listo</button>
      </div>`;
    panel.body.querySelector('[data-copy-cred]').onclick = () => copyText(text);
    panel.body.querySelector('[data-close]').onclick = () => panel.close();
  }

  // ------------------------------------------------------------ detalle
  function openDetail(id) {
    const u = st.users.find((x) => x.id === id);
    if (!u) return;
    const self = u.id === ctx.user.id;
    const panel = sidePanel(u.nombre || u.email);
    function draw() {
      const cur = st.users.find((x) => x.id === id);
      panel.setTitle(cur.nombre || cur.email);
      panel.body.innerHTML = `
        <form class="lite-form" data-info novalidate>
          <div class="crm-field">
            <label class="crm-field-label" for="eq-d-nombre">Nombre</label>
            <input id="eq-d-nombre" name="nombre" value="${esc(cur.nombre)}" maxlength="120">
          </div>
          <div class="crm-field">
            <label class="crm-field-label" for="eq-d-email">Correo</label>
            <input id="eq-d-email" name="email" type="email" value="${esc(cur.email)}">
          </div>
          <div class="lite-error" data-error></div>
          <div class="lite-actions"><button type="submit" class="btn-secondary">Guardar nombre y correo</button></div>
        </form>

        <div class="lite-section-title">Roles</div>
        <div data-roles-wrap>${roleChips(cur.roles, { lockAdmin: self })}</div>
        <p class="lite-hint eq-hint-after">Los cambios de roles se guardan solos. La persona los ve la próxima vez que inicie sesión.</p>

        <form class="lite-form" data-pass novalidate>
          <div class="lite-section-title">Cambiar contraseña</div>
          ${passwordField('nueva', 'Contraseña nueva')}
          <div class="lite-error" data-pass-error></div>
          <div class="lite-actions"><button type="submit" class="btn-secondary">Guardar contraseña</button></div>
        </form>

        <div class="lite-section-title">Estado</div>
        <p class="eq-state"><span class="users-status${cur.activo ? '' : ' inactive'}">${cur.activo ? 'Activo' : 'Desactivado'}</span></p>
        ${
          self
            ? '<p class="lite-hint eq-hint-after">No te puedes desactivar a ti misma.</p>'
            : `<button type="button" class="${cur.activo ? 'btn-danger' : 'btn-secondary'}" data-active>${cur.activo ? 'Desactivar cuenta' : 'Reactivar cuenta'}</button>
               ${cur.activo ? '<p class="lite-hint eq-hint-after">Una cuenta desactivada no puede entrar. Sus agendas y reportes se conservan.</p>' : ''}`
        }`;
    }
    draw();

    async function save(fields, { onError } = {}) {
      try {
        const r = await patch(`/usuarios/${id}`, fields);
        upsertLocal(r.usuario);
        flashSaved();
        return r.usuario;
      } catch (err) {
        if (onError) onError(err.message);
        else toast(err.message, { error: true });
        return null;
      }
    }

    panel.body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      if (form.matches('[data-info]')) {
        const cur = st.users.find((x) => x.id === id);
        const errEl = form.querySelector('[data-error]');
        const nombre = form.nombre.value.trim();
        const email = form.email.value.trim();
        errEl.textContent = '';
        if (!nombre || !email) return (errEl.textContent = 'Completa el nombre y el correo.');
        const fields = {};
        if (nombre !== cur.nombre) fields.nombre = nombre;
        if (email.toLowerCase() !== cur.email) fields.email = email;
        if (!Object.keys(fields).length) return toast('No hay cambios');
        if (await save(fields, { onError: (m) => (errEl.textContent = m) })) {
          draw();
          toast('Guardado ✓');
        }
      } else if (form.matches('[data-pass]')) {
        const errEl = form.querySelector('[data-pass-error]');
        const pass = form.nueva.value;
        errEl.textContent = '';
        if (pass.length < 8) return (errEl.textContent = 'La contraseña debe tener al menos 8 caracteres.');
        if (await save({ password: pass }, { onError: (m) => (errEl.textContent = m) })) {
          const u2 = st.users.find((x) => x.id === id);
          const text = `Tu contraseña nueva de ${ctx.ajustes?.negocio || 'tu equipo'}:\nCorreo: ${u2.email}\nContraseña: ${pass}`;
          form.nueva.value = '';
          errEl.innerHTML = `<span class="eq-ok">Contraseña cambiada ✓</span> <button type="button" class="btn-ghost btn-sm" data-copy-pass>Copiar para enviarla</button>`;
          errEl.querySelector('[data-copy-pass]').onclick = () => copyText(text);
        }
      }
    });
    panel.body.addEventListener('change', async (e) => {
      const input = e.target.closest('[data-roles] input');
      if (!input) return;
      input.closest('label').classList.toggle('checked', input.checked);
      const roles = readRoles(panel.body);
      if (self && !roles.includes('admin')) roles.push('admin');
      if (!roles.length) {
        toast('Una persona necesita al menos un rol', { error: true });
        input.checked = true;
        input.closest('label').classList.add('checked');
        return;
      }
      if (!(await save({ roles }))) draw();
    });
    panel.body.addEventListener('click', async (e) => {
      const gen = e.target.closest('[data-generate]');
      if (gen) {
        const input = panel.body.querySelector(`[name="${gen.dataset.generate}"]`);
        input.value = generatePassword();
        input.focus();
        return;
      }
      if (e.target.closest('[data-active]')) {
        const cur = st.users.find((x) => x.id === id);
        if (cur.activo) {
          const ok = await confirmDialog(`${cur.nombre} ya no va a poder entrar. Sus agendas y reportes se conservan y la puedes reactivar cuando quieras.`, {
            title: '¿Desactivar esta cuenta?',
            ok: 'Desactivar',
            danger: true,
          });
          if (!ok) return;
        }
        if (await save({ activo: !cur.activo })) draw();
      }
    });
  }

  // ------------------------------------------------------------ eventos
  const offs = [
    on(root, 'click', '[data-create]', () => openCreate()),
    on(table, 'click', '[data-user]', (e, el) => openDetail(el.dataset.user)),
    on(table, 'keydown', '[data-user]', (e, el) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail(el.dataset.user);
      }
    }),
  ];
  await load();
  return () => {
    clearTimeout(savedTimer);
    offs.forEach((off) => off());
  };
}

