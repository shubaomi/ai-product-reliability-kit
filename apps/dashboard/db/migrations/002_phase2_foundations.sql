alter table api_keys add column if not exists rotated_from_id uuid references api_keys(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'api_keys_product_id_fkey'
      and conrelid = 'api_keys'::regclass
  ) then
    alter table api_keys
      add constraint api_keys_product_id_fkey
      foreign key (product_id) references products(product_id) on delete cascade;
  end if;
end $$;

create table if not exists compliance_scans (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references products(product_id) on delete cascade,
  environment text not null check (environment = 'local'),
  scanned_at timestamptz not null,
  tool_version text not null,
  standard_version text not null,
  score double precision not null check (score >= 0),
  max_score double precision not null check (max_score > 0 and score <= max_score),
  grade text not null,
  findings jsonb not null default '[]'::jsonb,
  verification jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  product_id text references products(product_id) on delete set null,
  actor_type text not null,
  actor_id text,
  action text not null,
  target_type text not null,
  target_id text,
  source_ip text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists compliance_scans_product_time_idx on compliance_scans (product_id, scanned_at desc);
create index if not exists audit_logs_product_time_idx on audit_logs (product_id, created_at desc);
create index if not exists audit_logs_action_time_idx on audit_logs (action, created_at desc);
