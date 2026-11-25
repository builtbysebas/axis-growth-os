// Color del sistema: cada negocio elige el color de su marca en Ajustes.
// Todo el diseño usa --accent / --accent-rgb / --accent-2 / --accent-ink /
// --accent-soft / --accent-softer (os.css); acá se calculan a partir de un color.
// Se guarda en ml_settings ('color') y en este navegador (para no ver el naranja
// un instante al abrir: index.html lo aplica antes de cargar nada).

export const DEFAULT_COLOR = '#ec4b28';

// Colores sugeridos. Todos dejan el texto blanco legible encima (botones).
export const THEMES = [
  { key: 'naranja', label: 'Naranja', color: '#ec4b28', color2: '#ff9448' },
  { key: 'rosa', label: 'Rosa', color: '#db2777', color2: '#f472b6' },
  { key: 'morado', label: 'Morado', color: '#7c3aed', color2: '#a78bfa' },
  { key: 'azul', label: 'Azul', color: '#2563eb', color2: '#60a5fa' },
  { key: 'turquesa', label: 'Turquesa', color: '#0e7490', color2: '#22d3ee' },
  { key: 'verde', label: 'Verde', color: '#047857', color2: '#34d399' },
  { key: 'vino', label: 'Vino', color: '#9f1239', color2: '#fb7185' },
  { key: 'grafito', label: 'Grafito', color: '#27272a', color2: '#71717a' },
];

const STORE_KEY = 'ago-theme';
const HEX = /^#[0-9a-f]{6}$/i;

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastWithWhite = (rgb) => 1.05 / (luminance(rgb) + 0.05);

/** Normaliza un color elegido: si es muy claro para texto blanco, lo oscurece. */
export function normalizeColor(hex) {
  if (!HEX.test(String(hex || ''))) return DEFAULT_COLOR;
  let rgb = toRgb(hex.toLowerCase());
  for (let i = 0; i < 20 && contrastWithWhite(rgb) < 3.2; i++) rgb = mix(rgb, [0, 0, 0], 0.08);
  return toHex(rgb);
}

/** Variables CSS para un color. */
export function themeVars(hex) {
  const color = normalizeColor(hex);
  const preset = THEMES.find((t) => t.color === color);
  const rgb = toRgb(color);
  return {
    '--accent': color,
    '--accent-2': preset ? preset.color2 : toHex(mix(rgb, [255, 255, 255], 0.35)),
    '--accent-rgb': rgb.join(', '),
    '--accent-ink': toHex(mix(rgb, [0, 0, 0], 0.18)),
    '--accent-soft': toHex(mix(rgb, [255, 255, 255], 0.88)),
    '--accent-softer': toHex(mix(rgb, [255, 255, 255], 0.94)),
  };
}

function setFavicon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22.5" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="800" fill="#fff" text-anchor="middle">A</text></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Aplica el color a toda la app (y lo recuerda en este navegador). */
export function applyTheme(hex) {
  const vars = themeVars(hex || DEFAULT_COLOR);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  setFavicon(vars['--accent']);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(vars));
  } catch {
    /* sin almacenamiento: se aplica igual en cada carga */
  }
  return vars['--accent'];
}
