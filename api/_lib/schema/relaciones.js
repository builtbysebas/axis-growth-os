// Llaves entre módulos que se crean al final (cuando ya existen todas las tablas).
// Si se borra un contenido, los avisos y agendas que apuntaban a él quedan sin contenido
// (no con un id huérfano). Primero se limpian los ids que ya no existen.
export const sql = `
update ml_eventos set contenido_id = null where contenido_id is not null and contenido_id not in (select id from ml_contenido);
update ml_ventas set atrib_contenido_id = null where atrib_contenido_id is not null and atrib_contenido_id not in (select id from ml_contenido);
update ml_eventos set setter_id = null where setter_id is not null and setter_id not in (select id from ml_usuarios);
do $$ begin
  alter table ml_eventos add constraint ml_eventos_contenido_fk foreign key (contenido_id) references ml_contenido(id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table ml_ventas add constraint ml_ventas_atrib_contenido_fk foreign key (atrib_contenido_id) references ml_contenido(id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table ml_eventos add constraint ml_eventos_setter_fk foreign key (setter_id) references ml_usuarios(id) on delete set null;
exception when duplicate_object then null; end $$;
`;
