// Clientes (se crean solos cuando una llamada termina en venta), pagos y renovaciones.
export const sql = `
create table if not exists ml_cliente_etapas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  orden int not null default 0,
  tipo text not null default ''          -- entrada | renovar | perdido | ''
);
create table if not exists ml_clientes (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid unique references ml_ventas(id) on delete set null,
  nombre text not null,
  telefono text not null default '',
  email text not null default '',
  instagram text not null default '',
  contact_id text not null default '',
  etapa_id uuid references ml_cliente_etapas(id) on delete set null,
  coach_id uuid references ml_usuarios(id) on delete set null,
  programa text not null default '',
  meses int,
  ticket numeric(12,2),
  inicio date,
  vence date,
  notas text not null default '',
  orden double precision not null default 0,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create table if not exists ml_renovaciones (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references ml_clientes(id) on delete cascade,
  programa text not null default '',
  meses int,
  monto_total numeric(12,2),
  inicio date,
  vence date,
  user_id uuid references ml_usuarios(id) on delete set null,
  creado timestamptz not null default now()
);
create table if not exists ml_pagos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references ml_clientes(id) on delete cascade,
  renovacion_id uuid references ml_renovaciones(id) on delete set null,
  monto numeric(12,2) not null,
  pagado timestamptz not null default now(),
  metodo text not null default '',
  nota text not null default '',
  user_id uuid references ml_usuarios(id) on delete set null,
  creado timestamptz not null default now()
);
create index if not exists ml_pagos_pagado on ml_pagos (pagado);
create index if not exists ml_pagos_cliente on ml_pagos (cliente_id);
create table if not exists ml_cliente_notas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references ml_clientes(id) on delete cascade,
  user_id uuid references ml_usuarios(id) on delete set null,
  texto text not null,
  creado timestamptz not null default now()
);
-- Para qué fecha de vencimiento ya se pasó solo a la columna «Renovar» (una sola vez por fecha).
alter table ml_clientes add column if not exists renovar_para date;
create index if not exists ml_clientes_etapa on ml_clientes (etapa_id, orden);
create index if not exists ml_renovaciones_cliente on ml_renovaciones (cliente_id);
create index if not exists ml_cliente_notas_cliente on ml_cliente_notas (cliente_id, creado);
`;

export const CLIENTE_ETAPAS_INICIALES = [
  ['Nuevo ingreso', 'entrada'],
  ['En proceso', ''],
  ['Renovar', 'renovar'],
  ['Renovado', ''],
  ['Perdido', 'perdido'],
];
