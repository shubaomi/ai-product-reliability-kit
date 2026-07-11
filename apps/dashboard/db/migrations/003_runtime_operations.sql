alter table products
  add column if not exists public_status_enabled boolean not null default false;

update products
set public_status_enabled = true
where contract #>> '{public_status,enabled}' = 'true';

alter table monitors
  add column if not exists environment text;

update monitors
set environment = coalesce(nullif(config->>'environment', ''), 'production')
where environment is null or environment = 'production';

alter table monitors
  alter column environment set default 'production',
  alter column environment set not null;

create or replace function apr_monitor_environment_compat()
returns trigger language plpgsql as $$
begin
  new.environment := coalesce(nullif(new.config->>'environment', ''), new.environment, 'production');
  return new;
end $$;

drop trigger if exists apr_monitor_environment_compat_trigger on monitors;
create trigger apr_monitor_environment_compat_trigger
before insert or update of config, environment on monitors
for each row execute function apr_monitor_environment_compat();

alter table monitor_runs
  add column if not exists environment text,
  add column if not exists severity text,
  add column if not exists failure_threshold integer,
  add column if not exists interval_seconds integer;

update monitor_runs as run
set product_id = monitor.product_id,
    environment = monitor.environment,
    severity = monitor.severity,
    failure_threshold = case when monitor.config->>'failure_threshold' ~ '^[1-9][0-9]*$'
      then (monitor.config->>'failure_threshold')::integer else 2 end,
    interval_seconds = case when monitor.config->>'interval_seconds' ~ '^[1-9][0-9]*$'
      then (monitor.config->>'interval_seconds')::integer else 60 end
from monitors as monitor
where run.monitor_id = monitor.id;

alter table monitor_runs
  alter column environment set default 'production',
  alter column environment set not null,
  alter column severity set default 'medium',
  alter column severity set not null,
  alter column failure_threshold set default 2,
  alter column failure_threshold set not null,
  alter column interval_seconds set default 60,
  alter column interval_seconds set not null;

create or replace function apr_monitor_run_compat()
returns trigger language plpgsql as $$
declare
  monitor_record monitors%rowtype;
begin
  select * into monitor_record from monitors where id = new.monitor_id;
  if found then
    if new.product_id is distinct from monitor_record.product_id then
      raise exception 'monitor run product does not own monitor %', new.monitor_id using errcode = '23514';
    end if;
    new.product_id := monitor_record.product_id;
    new.environment := monitor_record.environment;
    new.severity := monitor_record.severity;
    new.failure_threshold := case when monitor_record.config->>'failure_threshold' ~ '^[1-9][0-9]*$'
      then (monitor_record.config->>'failure_threshold')::integer else coalesce(new.failure_threshold, 2) end;
    new.interval_seconds := case when monitor_record.config->>'interval_seconds' ~ '^[1-9][0-9]*$'
      then (monitor_record.config->>'interval_seconds')::integer else coalesce(new.interval_seconds, 60) end;
  end if;
  return new;
end $$;

drop trigger if exists apr_monitor_run_compat_trigger on monitor_runs;
create trigger apr_monitor_run_compat_trigger
before insert or update of monitor_id, environment, severity, failure_threshold, interval_seconds on monitor_runs
for each row execute function apr_monitor_run_compat();

alter table alerts
  add column if not exists type text,
  add column if not exists environment text,
  add column if not exists config jsonb not null default '{}'::jsonb;

update alerts
set type = case
      when condition ilike '%error%' then 'error_spike'
      when condition ilike '%success_event%' then 'journey_drop'
      when condition ilike '%stale%' then 'telemetry_stale'
      else 'availability_failure'
    end,
    environment = coalesce(environment, 'production'),
    enabled = false,
    config = jsonb_build_object(
      'legacy_migration', true,
      'original_condition', condition,
      'migration_advice', 'Recreate this disabled legacy rule as a structured environment-scoped alert.'
    )
where type is null;

update alerts
set environment = 'production'
where environment is null;

alter table alerts
  alter column type set not null,
  alter column environment set default 'production',
  alter column environment set not null,
  alter column condition drop not null;

create or replace function apr_alert_legacy_compat()
returns trigger language plpgsql as $$
begin
  if new.type is null then
    new.type := case
      when new.condition ilike '%error%' then 'error_spike'
      when new.condition ilike '%success_event%' then 'journey_drop'
      when new.condition ilike '%stale%' then 'telemetry_stale'
      else 'availability_failure'
    end;
    new.config := coalesce(new.config, '{}'::jsonb) || jsonb_build_object(
      'legacy_migration', true,
      'original_condition', new.condition,
      'migration_advice', 'Recreate this disabled legacy rule as a structured environment-scoped alert.'
    );
  end if;
  new.environment := coalesce(new.environment, 'production');
  if new.config->>'legacy_migration' = 'true' then
    new.enabled := false;
  end if;
  return new;
end $$;

drop trigger if exists apr_alert_legacy_compat_trigger on alerts;
create trigger apr_alert_legacy_compat_trigger
before insert or update on alerts
for each row execute function apr_alert_legacy_compat();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_structured_type_check') then
    alter table alerts add constraint alerts_structured_type_check
      check (type in ('availability_failure', 'telemetry_stale', 'error_spike', 'journey_drop'));
  end if;
end $$;

create table if not exists alert_instances (
  id uuid primary key default gen_random_uuid(),
  rule_id text not null references alerts(id) on delete cascade,
  rule_type text not null,
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  dedup_key text not null unique,
  name text not null,
  severity text not null default 'medium',
  status text not null check (status in ('open', 'acknowledged', 'resolved')),
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  last_seen_at timestamptz not null,
  last_notified_at timestamptz,
  recovery_count integer not null default 0,
  recovery_notified_at timestamptz,
  occurrence_count integer not null default 1,
  updated_at timestamptz not null default now()
);

create or replace function apr_alert_instance_compat()
returns trigger language plpgsql as $$
declare
  alert_record alerts%rowtype;
begin
  select * into alert_record from alerts where id = new.rule_id;
  if not found then
    raise exception 'alert rule does not exist: %', new.rule_id using errcode = '23503';
  end if;
  if new.product_id is distinct from alert_record.product_id
     or new.environment is distinct from alert_record.environment then
    raise exception 'alert instance ownership does not match rule %', new.rule_id using errcode = '23514';
  end if;
  if left(new.dedup_key, length(new.product_id || ':' || new.environment || ':'))
     <> new.product_id || ':' || new.environment || ':' then
    raise exception 'alert instance dedup key is outside the rule ownership scope' using errcode = '23514';
  end if;
  new.product_id := alert_record.product_id;
  new.environment := alert_record.environment;
  new.rule_type := alert_record.type;
  return new;
end $$;

drop trigger if exists apr_alert_instance_compat_trigger on alert_instances;
create trigger apr_alert_instance_compat_trigger
before insert or update of rule_id, rule_type, product_id, environment, dedup_key on alert_instances
for each row execute function apr_alert_instance_compat();

alter table alert_deliveries
  add column if not exists environment text,
  add column if not exists dedup_key text,
  add column if not exists notification_type text not null default 'alert';

update alert_deliveries as delivery
set product_id = alert.product_id,
    environment = alert.environment
from alerts as alert
where delivery.alert_id = alert.id;

alter table alert_deliveries
  alter column environment set default 'production',
  alter column environment set not null;

create or replace function apr_alert_delivery_compat()
returns trigger language plpgsql as $$
declare
  alert_product_id text;
  alert_environment text;
begin
  select product_id, environment into alert_product_id, alert_environment from alerts where id = new.alert_id;
  if found and new.product_id is distinct from alert_product_id then
    raise exception 'alert delivery product does not own alert %', new.alert_id using errcode = '23514';
  end if;
  new.product_id := coalesce(alert_product_id, new.product_id);
  new.environment := coalesce(alert_environment, new.environment, 'production');
  return new;
end $$;

drop trigger if exists apr_alert_delivery_compat_trigger on alert_deliveries;
create trigger apr_alert_delivery_compat_trigger
before insert or update of alert_id, environment on alert_deliveries
for each row execute function apr_alert_delivery_compat();

alter table status_pages
  add column if not exists public_summary text,
  add column if not exists components jsonb not null default '[]'::jsonb;

alter table incidents
  add column if not exists environment text not null default 'production',
  add column if not exists owner text,
  add column if not exists alert_ids jsonb not null default '[]'::jsonb,
  add column if not exists recovery_note text,
  add column if not exists timeline jsonb not null default '[]'::jsonb,
  add column if not exists opened_at timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by text,
  add column if not exists resolved_at timestamptz;

update incidents set opened_at = coalesce(opened_at, created_at);

create table if not exists maintenance_windows (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists daily_aggregates (
  bucket_date date not null,
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  event_count bigint not null default 0,
  error_count bigint not null default 0,
  health_ok_count bigint not null default 0,
  health_failure_count bigint not null default 0,
  monitor_ok_count bigint not null default 0,
  monitor_failure_count bigint not null default 0,
  alert_delivery_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket_date, product_id, environment)
);

create index if not exists health_checks_product_environment_time_idx on health_checks (product_id, environment, occurred_at desc);
create index if not exists monitor_runs_product_environment_time_idx on monitor_runs (product_id, environment, checked_at desc);
create index if not exists alert_instances_product_environment_status_idx on alert_instances (product_id, environment, status);
create index if not exists incidents_product_environment_status_idx on incidents (product_id, environment, status);
create index if not exists maintenance_windows_active_idx on maintenance_windows (product_id, environment, starts_at, ends_at);
