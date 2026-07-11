create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin', 'operator', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  product_id text,
  name text not null,
  key_hash text not null unique,
  scopes text[] not null default array['ingest'],
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  product_id text not null unique,
  name text not null,
  owner text not null,
  standard_version text not null,
  environments jsonb not null default '[]'::jsonb,
  critical_journeys jsonb not null default '[]'::jsonb,
  contract jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists telemetry_events (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  release text not null,
  event_name text not null,
  anonymous_id text,
  user_id text,
  request_id text,
  idempotency_key text,
  occurred_at timestamptz not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (product_id, idempotency_key)
);

create table if not exists telemetry_errors (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  release text not null,
  error_name text not null,
  message text not null,
  request_id text,
  occurred_at timestamptz not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists health_checks (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  release text not null,
  ok boolean not null,
  checks jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create table if not exists releases (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  environment text not null,
  version text not null,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (product_id, environment, version)
);

create table if not exists monitors (
  id text primary key,
  product_id text not null references products(product_id) on delete cascade,
  type text not null check (type in ('http', 'collector', 'event-freshness')),
  name text not null,
  config jsonb not null,
  severity text not null default 'medium',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists monitor_runs (
  id uuid primary key default gen_random_uuid(),
  monitor_id text not null references monitors(id) on delete cascade,
  product_id text not null references products(product_id) on delete cascade,
  ok boolean not null,
  status text not null,
  latency_ms integer,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

create table if not exists alerts (
  id text primary key,
  product_id text not null references products(product_id) on delete cascade,
  name text not null,
  condition text not null,
  severity text not null default 'medium',
  notify jsonb not null default '[]'::jsonb,
  action text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id text not null references alerts(id) on delete cascade,
  product_id text not null references products(product_id) on delete cascade,
  channel text not null,
  status text not null,
  message text not null,
  response jsonb not null default '{}'::jsonb,
  delivered_at timestamptz not null default now()
);

create table if not exists status_pages (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  title text not null,
  body text not null,
  public_slug text not null unique,
  generated_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  title text not null,
  severity text not null default 'medium',
  status text not null default 'open',
  package_markdown text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telemetry_events_product_time_idx on telemetry_events (product_id, occurred_at desc);
create index if not exists telemetry_events_product_name_time_idx on telemetry_events (product_id, event_name, occurred_at desc);
create index if not exists telemetry_errors_product_time_idx on telemetry_errors (product_id, occurred_at desc);
create index if not exists telemetry_errors_product_release_idx on telemetry_errors (product_id, release);
create index if not exists health_checks_product_time_idx on health_checks (product_id, occurred_at desc);
create index if not exists releases_product_time_idx on releases (product_id, occurred_at desc);
create index if not exists monitor_runs_monitor_time_idx on monitor_runs (monitor_id, checked_at desc);
create index if not exists monitor_runs_product_time_idx on monitor_runs (product_id, checked_at desc);
create index if not exists alerts_product_enabled_idx on alerts (product_id) where enabled = true;
create index if not exists monitors_product_enabled_idx on monitors (product_id) where enabled = true;
create index if not exists api_keys_hash_active_idx on api_keys (key_hash) where revoked_at is null;
create unique index if not exists users_organization_email_unique_idx on users (organization_id, lower(email));
