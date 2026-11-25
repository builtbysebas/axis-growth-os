// Usuarios, ajustes y eventos de ManyChat.
export const sql = `
create table if not exists ml_settings (
  key text primary key,
  value text not null
);
create table if not exists ml_usuarios (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  email text not null unique,
  roles text not null default '',
  password text not null,
  activo boolean not null default true,
  creado timestamptz not null default now()
);
-- Avisos de ManyChat (respuesta a contenido, llamada propuesta, link enviado).
create table if not exists ml_eventos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null,
  contact_id text not null default '',
  codigo text not null default '',
  setter_email text not null default '',
  usuario_ig text not null default '',
  nombre text not null default '',
  recibido timestamptz not null default now(),
  datos jsonb
);
alter table ml_eventos add column if not exists contenido_id uuid;
alter table ml_eventos add column if not exists setter_id uuid;
create index if not exists ml_eventos_recibido on ml_eventos (recibido desc);
create index if not exists ml_eventos_contact on ml_eventos (contact_id);
create index if not exists ml_eventos_contenido on ml_eventos (contenido_id);
-- Intentos de login fallidos (freno contra adivinar contraseñas).
create table if not exists ml_login_fallos (
  id bigserial primary key,
  email text not null,
  ip text not null default '',
  creado timestamptz not null default now()
);
create index if not exists ml_login_fallos_email on ml_login_fallos (email, creado);
`;
