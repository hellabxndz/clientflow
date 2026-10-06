-- ClientFlow initial schema.
-- Tenant tables carry workspace_id (and client_id where client access applies) and are
-- protected by row-level security. The application switches to the restricted
-- `clientflow_app` role inside every tenant transaction (see src/lib/db.ts), so these
-- policies apply even when the connection user owns the tables.

create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clientflow_app') then
    create role clientflow_app nologin;
  end if;
end $$;

-- Allow the connecting (owner) user to SET ROLE clientflow_app.
do $$
begin
  execute format('grant clientflow_app to %I', current_user);
exception when others then
  raise notice 'could not grant clientflow_app to %: %', current_user, sqlerrm;
end $$;

create schema if not exists app;
grant usage on schema app to clientflow_app;

create or replace function app.ws() returns uuid
  language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;
create or replace function app.role() returns text
  language sql stable as $$ select coalesce(nullif(current_setting('app.role', true), ''), 'none') $$;
create or replace function app.client() returns uuid
  language sql stable as $$ select nullif(current_setting('app.client_id', true), '')::uuid $$;
create or replace function app.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app.is_staff() returns boolean
  language sql stable as $$ select app.role() in ('admin', 'staff', 'system') $$;

-- ---------------------------------------------------------------------------
-- Identity (accessed by the auth module outside tenant context)
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  password_hash text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_demo boolean not null default false,
  brand_color text not null default '#7647e8',
  logo_url text,
  portal_welcome text not null default 'Welcome! Here is everything we need from you to get started.',
  timezone text not null default 'America/New_York',
  email_from_name text,
  template_edit_role text not null default 'admin' check (template_edit_role in ('admin', 'staff')),
  ai_enabled boolean not null default true,
  ai_process_documents boolean not null default false,
  retention_days integer check (retention_days is null or retention_days >= 30),
  max_upload_mb integer not null default 25 check (max_upload_mb between 1 and 100),
  created_at timestamptz not null default now()
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  industry text,
  website text,
  timezone text not null default 'America/New_York',
  primary_contact_name text,
  primary_contact_email citext,
  owner_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on clients (workspace_id);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'staff', 'client')),
  client_id uuid references clients(id) on delete cascade,
  can_approve boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id),
  check ((role = 'client') = (client_id is not null))
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete set null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index on sessions (user_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email citext not null,
  role text not null check (role in ('admin', 'staff', 'client')),
  client_id uuid references clients(id) on delete cascade,
  token_hash text not null unique,
  invited_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((role = 'client') = (client_id is not null))
);
create index on invitations (workspace_id);

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

create table templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  category text not null default 'general',
  draft jsonb not null default '{"sections": []}',
  current_version integer not null default 0,
  archived boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on templates (workspace_id);

create table template_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  template_id uuid not null references templates(id) on delete cascade,
  version integer not null,
  content jsonb not null,
  change_note text,
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (template_id, version)
);

-- Published versions are immutable.
create or replace function app.template_versions_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception 'template versions are immutable';
end $$;
create trigger template_versions_no_update before update on template_versions
  for each row execute function app.template_versions_immutable();

-- ---------------------------------------------------------------------------
-- Onboardings
-- ---------------------------------------------------------------------------

create table onboardings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  template_id uuid references templates(id) on delete set null,
  template_version_id uuid references template_versions(id) on delete set null,
  template_version integer,
  template_name text,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'cancelled')),
  start_date date not null default current_date,
  target_date date,
  owner_user_id uuid references users(id) on delete set null,
  reminders_enabled boolean not null default true,
  paused_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references users(id) on delete set null,
  completion_note text,
  created_at timestamptz not null default now()
);
create index on onboardings (workspace_id, status);
create index on onboardings (client_id);

create table onboarding_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  section_key text not null,
  section_title text not null,
  item_key text not null,
  position integer not null default 0,
  kind text not null check (kind in ('form', 'file', 'checklist', 'question', 'task', 'signature')),
  title text not null,
  description text,
  audience text not null check (audience in ('client', 'internal')),
  required boolean not null default true,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'submitted', 'changes_requested', 'approved')),
  due_at timestamptz,
  owner_user_id uuid references users(id) on delete set null,
  depends_on text[] not null default '{}',
  config jsonb not null default '{}',
  response jsonb not null default '{}',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (onboarding_id, item_key)
);
create index on onboarding_items (workspace_id, status);
create index on onboarding_items (onboarding_id);

create table comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  item_id uuid references onboarding_items(id) on delete cascade,
  author_user_id uuid references users(id) on delete set null,
  visibility text not null check (visibility in ('client', 'internal')),
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index on comments (onboarding_id);

create table documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  item_id uuid not null references onboarding_items(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);
create index on documents (item_id);

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  version integer not null,
  storage_key text,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  scan_status text not null default 'not_scanned'
    check (scan_status in ('not_scanned', 'pending', 'clean', 'infected', 'error')),
  scan_detail text,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'changes_requested')),
  review_note text,
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  uploaded_by uuid references users(id) on delete set null,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);

-- ---------------------------------------------------------------------------
-- Reminders and email
-- ---------------------------------------------------------------------------

create table reminder_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  trigger text not null check (trigger in ('before_due', 'overdue', 'no_activity')),
  offset_days integer not null default 0 check (offset_days between 0 and 60),
  repeat_every_days integer check (repeat_every_days is null or repeat_every_days between 1 and 30),
  send_hour integer not null default 9 check (send_hour between 0 and 23),
  subject text not null,
  body text not null,
  enabled boolean not null default false,
  previewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (not enabled or previewed_at is not null)
);

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('reminder', 'invitation', 'notification')),
  rule_id uuid references reminder_rules(id) on delete set null,
  onboarding_id uuid references onboardings(id) on delete cascade,
  item_ids uuid[] not null default '{}',
  dedupe_key text unique,
  to_email citext not null,
  subject text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'simulated', 'failed')),
  provider text,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on email_messages (workspace_id, created_at desc);

create table audit_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  summary text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on audit_events (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Grants for the restricted application role
-- ---------------------------------------------------------------------------

grant select (id, name, email) on users to clientflow_app;
grant select on workspaces, memberships to clientflow_app;
grant update (name, brand_color, logo_url, portal_welcome, timezone, email_from_name, template_edit_role,
  ai_enabled, ai_process_documents, retention_days, max_upload_mb) on workspaces to clientflow_app;
grant update (role, can_approve) on memberships to clientflow_app;
grant delete on memberships to clientflow_app;
grant select, insert, update, delete on clients, templates, template_versions, onboardings, onboarding_items,
  comments, documents, document_versions, reminder_rules, email_messages to clientflow_app;
grant select, insert on audit_events to clientflow_app;
grant usage on sequence audit_events_id_seq to clientflow_app;
grant select, insert, update on invitations to clientflow_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table workspaces enable row level security;
create policy ws_read on workspaces for select using (id = app.ws());
create policy ws_admin_update on workspaces for update using (id = app.ws() and app.role() = 'admin');

alter table memberships enable row level security;
create policy mem_read on memberships for select using (workspace_id = app.ws());
create policy mem_admin on memberships for update using (workspace_id = app.ws() and app.role() = 'admin');
create policy mem_admin_delete on memberships for delete using (workspace_id = app.ws() and app.role() = 'admin');

alter table invitations enable row level security;
create policy inv_staff on invitations for all
  using (workspace_id = app.ws() and app.is_staff())
  with check (workspace_id = app.ws() and app.is_staff() and (role = 'client' or app.role() in ('admin', 'system')));

alter table clients enable row level security;
create policy clients_staff on clients for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy clients_self on clients for select
  using (workspace_id = app.ws() and app.role() = 'client' and id = app.client());

alter table templates enable row level security;
create policy templates_staff on templates for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());

alter table template_versions enable row level security;
create policy tv_staff on template_versions for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());

alter table onboardings enable row level security;
create policy onb_staff on onboardings for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy onb_client on onboardings for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client());

alter table onboarding_items enable row level security;
create policy items_staff on onboarding_items for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy items_client_read on onboarding_items for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and audience = 'client');
create policy items_client_update on onboarding_items for update
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and audience = 'client')
  with check (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and audience = 'client');

-- Clients may only move their own items between draft and submitted states, and may not
-- change anything but the response.
create or replace function app.guard_client_item_update() returns trigger
  language plpgsql as $$
begin
  if app.role() = 'client' then
    if new.status not in ('in_progress', 'submitted') then
      raise exception 'clients cannot set status %', new.status;
    end if;
    if old.status = 'approved' then
      raise exception 'approved items are locked';
    end if;
    if new.title is distinct from old.title or new.required is distinct from old.required
       or new.due_at is distinct from old.due_at or new.owner_user_id is distinct from old.owner_user_id
       or new.config is distinct from old.config or new.audience is distinct from old.audience
       or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
       or new.depends_on is distinct from old.depends_on or new.onboarding_id is distinct from old.onboarding_id then
      raise exception 'clients may only update responses';
    end if;
  end if;
  return new;
end $$;
create trigger onboarding_items_client_guard before update on onboarding_items
  for each row execute function app.guard_client_item_update();

alter table comments enable row level security;
create policy comments_staff on comments for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy comments_client_read on comments for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and visibility = 'client');
create policy comments_client_insert on comments for insert
  with check (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client()
    and visibility = 'client' and author_user_id = app.uid()
    and exists (select 1 from onboardings o where o.id = onboarding_id)
    and (item_id is null or exists (select 1 from onboarding_items i where i.id = item_id)));

alter table documents enable row level security;
create policy docs_staff on documents for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy docs_client_read on documents for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client()
    and exists (select 1 from onboarding_items i where i.id = item_id));
create policy docs_client_insert on documents for insert
  with check (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client()
    and exists (select 1 from onboarding_items i where i.id = item_id and i.status <> 'approved'));

alter table document_versions enable row level security;
create policy dv_staff on document_versions for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy dv_client_read on document_versions for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client()
    and exists (select 1 from documents d where d.id = document_id));
create policy dv_client_insert on document_versions for insert
  with check (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client()
    and review_status = 'pending' and uploaded_by = app.uid()
    and exists (select 1 from documents d where d.id = document_id));

alter table reminder_rules enable row level security;
create policy rr_staff on reminder_rules for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());

alter table email_messages enable row level security;
create policy em_staff on email_messages for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());

alter table audit_events enable row level security;
create policy audit_read on audit_events for select using (workspace_id = app.ws() and app.is_staff());
create policy audit_insert on audit_events for insert
  with check (workspace_id = app.ws() and (actor_user_id is null or actor_user_id = app.uid()));
