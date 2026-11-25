// EOD (reporte diario), metas y ajustes del dashboard.
export const sql = `
create table if not exists ml_eod_preguntas (
  id uuid primary key default gen_random_uuid(),
  texto text not null,
  tipo text not null default 'numero',   -- numero | texto | sino
  roles text not null default 'setter',  -- separados por coma
  orden int not null default 0,
  activa boolean not null default true,
  creado timestamptz not null default now()
);
create table if not exists ml_eod_envios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references ml_usuarios(id) on delete cascade,
  fecha date not null,
  respuestas jsonb not null default '{}',
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  unique (user_id, fecha)
);
create table if not exists ml_metas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references ml_usuarios(id) on delete cascade, -- null = meta del negocio
  metrica text not null,
  periodo text not null default 'mes',   -- semana | mes
  inicio date not null,
  valor numeric(12,2) not null,
  creado timestamptz not null default now(),
  unique (user_id, metrica, periodo, inicio)
);
`;

export const PREGUNTAS_INICIALES = [
  ['Outbound', 'numero', 'setter'],
  ['Respuestas a Outbound', 'numero', 'setter'],
  ['Inbound', 'numero', 'setter'],
  ['Follow ups', 'numero', 'setter'],
];
