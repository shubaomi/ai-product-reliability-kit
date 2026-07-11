create table if not exists ingest_dedup (
  product_id text not null,
  environment text not null,
  idempotency_key text not null,
  item_type text not null,
  received_at timestamptz not null default now(),
  primary key (product_id, environment, idempotency_key),
  constraint ingest_dedup_product_fkey foreign key (product_id)
    references products(product_id) on delete cascade deferrable initially deferred
);

create table if not exists status_pages_migration_archive (
  id uuid primary key,
  page jsonb not null,
  archived_at timestamptz not null default now()
);

alter table telemetry_events
  add column if not exists original_idempotency_key text;

update telemetry_events
set original_idempotency_key = idempotency_key
where idempotency_key is not null and original_idempotency_key is null;

update telemetry_events
set idempotency_key = null
where original_idempotency_key is not null;

update telemetry_events
set idempotency_key = environment || ':' || encode(digest(original_idempotency_key, 'sha256'), 'hex')
where original_idempotency_key is not null;

create or replace function apr_event_idempotency_scope()
returns trigger language plpgsql as $$
declare
  raw_key text;
  ledger_type text;
begin
  if tg_op = 'UPDATE' and (
    new.product_id is distinct from old.product_id
    or new.environment is distinct from old.environment
    or new.idempotency_key is distinct from old.idempotency_key
    or new.original_idempotency_key is distinct from old.original_idempotency_key
  ) then
    raise exception 'telemetry event ownership and idempotency identity are immutable' using errcode = '23514';
  end if;
  raw_key := coalesce(new.original_idempotency_key, new.idempotency_key);
  if raw_key is not null then
    new.original_idempotency_key := raw_key;
    new.idempotency_key := new.environment || ':' || encode(digest(raw_key, 'sha256'), 'hex');
    insert into ingest_dedup (product_id, environment, idempotency_key, item_type)
    values (new.product_id, new.environment, raw_key, 'event')
    on conflict (product_id, environment, idempotency_key) do update
      set item_type = ingest_dedup.item_type
    returning item_type into ledger_type;
    if ledger_type <> 'event' then
      raise exception 'idempotency key is already used for telemetry type %', ledger_type using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists apr_event_idempotency_scope_trigger on telemetry_events;
create trigger apr_event_idempotency_scope_trigger
before insert or update of product_id, environment, idempotency_key, original_idempotency_key on telemetry_events
for each row execute function apr_event_idempotency_scope();

alter table telemetry_errors
  add column if not exists idempotency_key text;

alter table health_checks
  add column if not exists idempotency_key text;

insert into ingest_dedup (product_id, environment, idempotency_key, item_type, received_at)
select product_id, environment, original_idempotency_key, 'event', received_at
from telemetry_events
where original_idempotency_key is not null
on conflict do nothing;

alter table alert_instances
  add column if not exists rule_type text;

update alert_instances as instance
set rule_type = alert.type,
    product_id = alert.product_id,
    environment = alert.environment
from alerts as alert
where instance.rule_id = alert.id;

alter table alert_instances
  alter column rule_type set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ingest_dedup_product_fkey') then
    alter table ingest_dedup add constraint ingest_dedup_product_fkey
      foreign key (product_id) references products(product_id) on delete cascade
      deferrable initially deferred;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alert_instances_rule_type_check') then
    alter table alert_instances add constraint alert_instances_rule_type_check
      check (rule_type in ('availability_failure', 'telemetry_stale', 'error_spike', 'journey_drop'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'monitors_owner_identity_unique') then
    alter table monitors add constraint monitors_owner_identity_unique unique (id, product_id, environment);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'monitor_runs_owner_fkey') then
    alter table monitor_runs add constraint monitor_runs_owner_fkey
      foreign key (monitor_id, product_id, environment)
      references monitors (id, product_id, environment) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alerts_owner_identity_unique') then
    alter table alerts add constraint alerts_owner_identity_unique unique (id, product_id, environment);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alert_instances_owner_fkey') then
    alter table alert_instances add constraint alert_instances_owner_fkey
      foreign key (rule_id, product_id, environment)
      references alerts (id, product_id, environment) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_owner_fkey') then
    alter table alert_deliveries add constraint alert_deliveries_owner_fkey
      foreign key (alert_id, product_id, environment)
      references alerts (id, product_id, environment) on delete cascade;
  end if;
end $$;

with ranked as (
  select id, row_number() over (partition by product_id order by updated_at desc, id desc) as position
  from status_pages
)
insert into status_pages_migration_archive (id, page)
select page.id, to_jsonb(page)
from status_pages as page
join ranked on ranked.id = page.id
where ranked.position > 1
on conflict (id) do nothing;

with ranked as (
  select id, row_number() over (partition by product_id order by updated_at desc, id desc) as position
  from status_pages
)
delete from status_pages
where id in (select id from ranked where position > 1);

insert into status_pages_migration_archive (id, page)
select page.id, to_jsonb(page)
from status_pages as page
join products as product on product.product_id = page.public_slug
where product.product_id <> page.product_id
on conflict (id) do nothing;

delete from status_pages as page
using products as product
where product.product_id = page.public_slug
  and product.product_id <> page.product_id;

create unique index if not exists status_pages_product_unique_idx on status_pages (product_id);

create or replace function apr_status_page_namespace_guard()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(1747790033);
  if exists (
    select 1 from products
    where product_id = new.public_slug and product_id <> new.product_id
  ) then
    raise exception 'status page public slug conflicts with another product ID: %', new.public_slug using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists apr_status_page_namespace_guard_trigger on status_pages;
create trigger apr_status_page_namespace_guard_trigger
before insert or update of product_id, public_slug on status_pages
for each row execute function apr_status_page_namespace_guard();

create or replace function apr_product_status_namespace_guard()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(1747790033);
  if exists (
    select 1 from status_pages
    where public_slug = new.product_id and product_id <> new.product_id
  ) then
    raise exception 'product ID conflicts with another public status slug: %', new.product_id using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists apr_product_status_namespace_guard_trigger on products;
create trigger apr_product_status_namespace_guard_trigger
before insert or update of product_id on products
for each row execute function apr_product_status_namespace_guard();

create index if not exists telemetry_events_time_idx on telemetry_events (occurred_at);
create index if not exists telemetry_errors_time_idx on telemetry_errors (occurred_at);
create index if not exists health_checks_time_idx on health_checks (occurred_at);
create index if not exists monitor_runs_time_idx on monitor_runs (checked_at);
create index if not exists alert_deliveries_time_idx on alert_deliveries (delivered_at);
create index if not exists ingest_dedup_received_at_idx on ingest_dedup (received_at);
