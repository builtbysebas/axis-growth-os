// Contenido (posts, historias y ads), ángulos, recursos y comentarios.
export const sql = `
create table if not exists ml_angulos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  descripcion text not null default '',
  orden int not null default 0,
  creado timestamptz not null default now()
);
create table if not exists ml_recursos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  link text not null default '',
  tipo text not null default '',
  descripcion text not null default '',
  creado timestamptz not null default now()
);
create table if not exists ml_contenido (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                    -- post | story | ad
  titulo text not null default '',
  codigo text not null unique,           -- lo que viaja a ManyChat (ej. "P - CALCULADORA - 26/08/2026")
  fecha date,
  estado text not null default 'idea',
  formato text not null default '',      -- Reel | Carrusel | Foto ... (posts)
  tipo_story text not null default '',   -- Poll | CTA | Q&A | Recurso Gratis ... (historias)
  angulo_id uuid references ml_angulos(id) on delete set null,
  cta text not null default '',
  gancho text not null default '',
  guion text not null default '',
  etiqueta text not null default '',
  link text not null default '',
  gasto numeric(12,2),
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create index if not exists ml_contenido_fecha on ml_contenido (kind, fecha);
create table if not exists ml_contenido_recursos (
  contenido_id uuid not null references ml_contenido(id) on delete cascade,
  recurso_id uuid not null references ml_recursos(id) on delete cascade,
  primary key (contenido_id, recurso_id)
);
create table if not exists ml_contenido_notas (
  id uuid primary key default gen_random_uuid(),
  contenido_id uuid not null references ml_contenido(id) on delete cascade,
  user_id uuid references ml_usuarios(id) on delete set null,
  texto text not null,
  creado timestamptz not null default now()
);
create index if not exists ml_contenido_recursos_recurso on ml_contenido_recursos (recurso_id);
create index if not exists ml_contenido_notas_contenido on ml_contenido_notas (contenido_id, creado);
`;

