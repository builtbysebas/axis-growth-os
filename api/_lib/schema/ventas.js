// CRM de Ventas: etapas, agendas (cards), notas y resultado de la llamada.
export const sql = `
create table if not exists ml_etapas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  orden int not null default 0,
  tipo text not null default ''          -- entrada | ganado | perdido | reagendar | ''
);
create table if not exists ml_ventas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  telefono text not null default '',
  email text not null default '',
  instagram text not null default '',
  contact_id text not null default '',
  etapa_id uuid references ml_etapas(id) on delete set null,
  setter_id uuid references ml_usuarios(id) on delete set null,
  closer_id uuid references ml_usuarios(id) on delete set null,
  fecha_llamada timestamptz,
  notas text not null default '',
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
-- Estatus tipo noCRM, separado de la etapa.
alter table ml_ventas add column if not exists status text not null default 'para_hoy'; -- para_hoy | standby | ganado | perdido | cancelado
alter table ml_ventas add column if not exists proxima_accion timestamptz;
-- Cuándo llegó la agenda (editable, para cargar leads viejos).
alter table ml_ventas add column if not exists agendada timestamptz not null default now();
alter table ml_ventas add column if not exists orden double precision not null default 0;
alter table ml_ventas add column if not exists presupuesto text not null default ''; -- con | sin | ''
alter table ml_ventas add column if not exists origen text not null default 'manual';
-- Atribución manual (gana sobre la automática): contenido o motivo libre.
alter table ml_ventas add column if not exists atrib_contenido_id uuid;
alter table ml_ventas add column if not exists atrib_motivo text not null default '';
-- Id de quien la mandó por webhook (ej. URI del invitado de Calendly): evita duplicados si reintenta.
alter table ml_ventas add column if not exists ref_externa text;
create unique index if not exists ml_ventas_ref_externa on ml_ventas (ref_externa) where ref_externa is not null;
create index if not exists ml_ventas_contact on ml_ventas (contact_id);
create index if not exists ml_ventas_agendada on ml_ventas (agendada);

create table if not exists ml_venta_notas (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ml_ventas(id) on delete cascade,
  user_id uuid references ml_usuarios(id) on delete set null,
  texto text not null,
  creado timestamptz not null default now()
);
create index if not exists ml_venta_notas_venta on ml_venta_notas (venta_id, creado);

-- Resultado de la llamada (uno por agenda; se corrige pisándolo).
create table if not exists ml_resultados (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null unique references ml_ventas(id) on delete cascade,
  resultado text not null,              -- venta | no_show | no_cerro | cancelada | reserva | pidio_reagendar
  programa text not null default '',
  meses int,
  monto_total numeric(12,2),
  pago_inicial numeric(12,2),
  metodo_pago text not null default '',
  cuotas int,
  motivo text not null default '',
  closer_id uuid references ml_usuarios(id) on delete set null,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
`;

export const ETAPAS_INICIALES = [
  ['Nuevo ingreso', 'entrada'],
  ['Agendas', ''],
  ['Reagendar', 'reagendar'],
  ['Ganado', 'ganado'],
  ['Perdido', 'perdido'],
];
