// Registro de pantallas: ruta, título, grupo del menú, roles que la ven y el
// módulo que la dibuja (se carga solo al abrirla).
// Cada módulo exporta `render(root, ctx)` y puede devolver una función de limpieza.
// ctx = { user, navigate(path), params (URLSearchParams), setParams(obj), ajustes, isAdmin, has(role) }
import { icons } from './dom.js';

export const PAGES = [
  // CRM
  { path: '/ventas', title: 'Ventas', group: 'CRM', icon: icons.funnel, roles: ['admin', 'setter', 'closer'], load: () => import('../pages/ventas.js') },
  { path: '/clientes', title: 'Clientes', group: 'CRM', icon: icons.users, roles: ['admin', 'coach'], load: () => import('../pages/clientes.js') },
  // Contenido
  { path: '/contenido/corto', title: 'Contenido Corto', group: 'Contenido', icon: icons.calendar, roles: null, load: () => import('../pages/contenido.js') },
  { path: '/contenido/stories', title: 'Stories', group: 'Contenido', icon: icons.calendar, roles: null, load: () => import('../pages/contenido.js') },
  { path: '/contenido/ads', title: 'Ads', group: 'Contenido', icon: icons.chart, roles: ['admin'], load: () => import('../pages/contenido.js') },
  { path: '/contenido/recursos', title: 'Recursos y Ángulos', group: 'Contenido', icon: icons.doc, roles: null, load: () => import('../pages/recursos.js') },
  { path: '/contenido/resultados', title: 'Resultados Contenido', group: 'Contenido', icon: icons.chart, roles: ['admin'], load: () => import('../pages/resultados.js') },
  // Reportes
  { path: '/dashboard', title: 'Dashboard', group: 'Reportes', icon: icons.chart, roles: ['admin'], load: () => import('../pages/dashboard.js') },
  { path: '/eod', title: 'Mi EOD', group: 'Reportes', icon: icons.check, roles: ['setter', 'closer', 'coach'], adminHidden: true, load: () => import('../pages/eod.js') },
  { path: '/admin/eod', title: 'EOD equipo', group: 'Reportes', icon: icons.check, roles: ['admin'], load: () => import('../pages/eod-equipo.js') },
  { path: '/metas', title: 'Metas', group: 'Reportes', icon: icons.target, roles: ['admin', 'setter', 'closer'], load: () => import('../pages/metas.js') },
  // Equipo
  { path: '/admin/usuarios', title: 'Usuarios', group: 'Equipo', icon: icons.users, roles: ['admin'], load: () => import('../pages/usuarios.js') },
  { path: '/ajustes', title: 'Ajustes', group: 'Equipo', icon: icons.gear, roles: ['admin'], load: () => import('../pages/ajustes.js') },
];

export const GROUPS = ['CRM', 'Contenido', 'Reportes', 'Equipo'];

export function canSee(page, user) {
  if (!page.roles) return true;
  const isAdmin = user.roles.includes('admin');
  if (page.adminHidden && isAdmin && !page.roles.some((r) => user.roles.includes(r))) return false;
  return isAdmin || page.roles.some((r) => user.roles.includes(r));
}

export function defaultPath(user) {
  const r = user.roles;
  if (r.includes('admin')) return '/dashboard';
  if (r.includes('setter') || r.includes('closer')) return '/ventas';
  if (r.includes('coach')) return '/clientes';
  return '/contenido/corto';
}
