-- ClientFlow operations platform: manager role, readiness inputs, automation engine,
-- integrations, notifications, imports, item history and richer reminders.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

alter table memberships drop constraint memberships_role_check;
alter table memberships add constraint memberships_role_check check (role in ('admin', 'manager', 'staff', 'client'));
alter table invitations drop constraint invitations_role_check;
alter table invitations add constraint invitations_role_check check (role in ('admin', 'manager', 'staff', 'client'));

create or replace function app.is_staff() returns boolean
  language sql stable as $$ select app.role() in ('admin', 'manager', 'staff', 'system') $$;
create or replace function app.is_manager() returns boolean
  language sql stable as $$ select app.role() in ('admin', 'manager', 'system') $$;
grant execute on all functions in schema app to clientflow_app;

-- ---------------------------------------------------------------------------
-- Workspace branding, business hours and implementation state
-- ---------------------------------------------------------------------------

alter table workspaces
  add column accent_color text not null default '#a78bfa',
  add column portal_name text,
  add column support_email citext,
  add column support_phone text,
  add column logo_storage_key text,
  add column logo_mime text,
  add column custom_domain text,
  add column custom_domain_checked_at timestamptz,
  add column custom_domain_status text not null default 'not_configured'
    check (custom_domain_status in ('not_configured', 'pending_dns', 'dns_verified', 'dns_failed')),
  add column business_days integer[] not null default '{1,2,3,4,5}',
  add column business_start_hour integer not null default 9 check (business_start_hour between 0 and 23),
  add column business_end_hour integer not null default 18 check (business_end_hour between 1 and 24),
  add column kickoff_lead_days integer not null default 2 check (kickoff_lead_days between 0 and 30),
  add column launch_checklist jsonb not null default '{}',
  add column launched_at timestamptz,
  add column deal_webhook_secret_hash text;

grant update (accent_color, portal_name, support_email, support_phone, logo_storage_key, logo_mime, custom_domain,
  custom_domain_checked_at, custom_domain_status, business_days, business_start_hour, business_end_hour,
  kickoff_lead_days, launch_checklist, launched_at) on workspaces to clientflow_app;
create policy ws_manager_update on workspaces for update using (id = app.ws() and app.role() = 'manager');

-- ---------------------------------------------------------------------------
-- Client types (service lines) and contacts
-- ---------------------------------------------------------------------------

create table client_types (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  template_id uuid references templates(id) on delete set null,
  default_owner_user_id uuid references users(id) on delete set null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

alter table clients
  add column client_type_id uuid references client_types(id) on delete set null,
  add column deal_amount numeric(12, 2) check (deal_amount is null or deal_amount >= 0),
  add column deal_recurrence text not null default 'one_time' check (deal_recurrence in ('one_time', 'monthly', 'annual')),
  add column source text not null default 'manual',
  add column external_id text,
  add column archived_at timestamptz;
create unique index clients_external on clients (workspace_id, source, external_id) where external_id is not null;

create table client_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  email citext,
  title text,
  contact_role text not null default 'other' check (contact_role in ('primary', 'billing', 'marketing', 'approver', 'other')),
  phone text,
  created_at timestamptz not null default now(),
  unique (client_id, email)
);
create index on client_contacts (client_id);

-- ---------------------------------------------------------------------------
-- Onboardings and items
-- ---------------------------------------------------------------------------

alter table onboardings
  add column kickoff_ready_at timestamptz,
  add column kickoff_date date,
  add column handed_off_at timestamptz,
  add column at_risk boolean not null default false,
  add column at_risk_reason text,
  add column at_risk_at timestamptz,
  add column source text not null default 'manual',
  add column last_client_activity_at timestamptz,
  add column upgraded_at timestamptz;

alter table onboarding_items drop constraint onboarding_items_status_check;
alter table onboarding_items add constraint onboarding_items_status_check
  check (status in ('not_started', 'in_progress', 'submitted', 'under_review', 'changes_requested', 'approved'));
alter table onboarding_items drop constraint onboarding_items_kind_check;
alter table onboarding_items add constraint onboarding_items_kind_check
  check (kind in ('form', 'file', 'checklist', 'question', 'task', 'signature', 'access'));
alter table onboarding_items
  add column weight integer not null default 1 check (weight between 1 and 10),
  add column critical boolean not null default false,
  add column review_required boolean not null default true,
  add column reviewer_user_id uuid references users(id) on delete set null,
  add column category text,
  add column removed_at timestamptz,
  add column status_changed_at timestamptz not null default now(),
  add column source_version integer;
create index on onboarding_items (reviewer_user_id) where status in ('submitted', 'under_review');

-- Clients may only see live requirements.
drop policy items_client_read on onboarding_items;
create policy items_client_read on onboarding_items for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and audience = 'client' and removed_at is null);
drop policy items_client_update on onboarding_items;
create policy items_client_update on onboarding_items for update
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and audience = 'client' and removed_at is null)
  with check (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client() and audience = 'client' and removed_at is null);

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
    if old.status = 'under_review' then
      raise exception 'items under review are locked until the team responds';
    end if;
    if new.title is distinct from old.title or new.required is distinct from old.required
       or new.due_at is distinct from old.due_at or new.owner_user_id is distinct from old.owner_user_id
       or new.config is distinct from old.config or new.audience is distinct from old.audience
       or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
       or new.depends_on is distinct from old.depends_on or new.onboarding_id is distinct from old.onboarding_id
       or new.weight is distinct from old.weight or new.critical is distinct from old.critical
       or new.review_required is distinct from old.review_required or new.reviewer_user_id is distinct from old.reviewer_user_id
       or new.category is distinct from old.category or new.removed_at is distinct from old.removed_at then
      raise exception 'clients may only update responses';
    end if;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end $$;

create table item_status_history (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  item_id uuid not null references onboarding_items(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_user_id uuid references users(id) on delete set null,
  actor_role text,
  created_at timestamptz not null default now()
);
create index on item_status_history (onboarding_id, created_at);
create index on item_status_history (workspace_id, created_at);

alter table comments alter column author_user_id drop not null;
alter table comments add column source text not null default 'user' check (source in ('user', 'automation', 'system'));

alter table documents add column category text;
alter table document_versions drop constraint document_versions_review_status_check;
alter table document_versions add constraint document_versions_review_status_check
  check (review_status in ('pending', 'approved', 'changes_requested', 'rejected'));
alter table document_versions add column expires_on date;

-- ---------------------------------------------------------------------------
-- Automation engine: transactional event outbox, rules and idempotent runs
-- ---------------------------------------------------------------------------

create table automation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  type text not null,
  client_id uuid references clients(id) on delete cascade,
  onboarding_id uuid references onboardings(id) on delete cascade,
  item_id uuid references onboarding_items(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  payload jsonb not null default '{}',
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  error text
);
create index automation_events_pending on automation_events (workspace_id, created_at) where processed_at is null;

create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  category text not null default 'automation' check (category in ('automation', 'escalation', 'handoff')),
  enabled boolean not null default false,
  trigger text not null,
  trigger_config jsonb not null default '{}',
  conditions jsonb not null default '[]',
  condition_mode text not null default 'all' check (condition_mode in ('all', 'any')),
  actions jsonb not null default '[]',
  run_mode text not null default 'once_per_onboarding' check (run_mode in ('once_per_onboarding', 'every_event')),
  template_id uuid references templates(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on automation_rules (workspace_id, trigger) where enabled;

create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  rule_id uuid not null references automation_rules(id) on delete cascade,
  event_id uuid references automation_events(id) on delete set null,
  client_id uuid references clients(id) on delete cascade,
  onboarding_id uuid references onboardings(id) on delete cascade,
  dedupe_key text not null,
  trigger text not null,
  status text not null check (status in ('succeeded', 'partial', 'failed', 'skipped')),
  results jsonb not null default '[]',
  error text,
  created_at timestamptz not null default now(),
  unique (rule_id, dedupe_key)
);
create index on automation_runs (workspace_id, created_at desc);
create index on automation_runs (onboarding_id);

-- Emit events and history from the database itself so every write path is covered.
create or replace function app.item_events() returns trigger
  language plpgsql security definer set search_path = public, app as $$
declare
  evt text;
begin
  if app.role() = 'client' then
    update onboardings set last_client_activity_at = now() where id = new.onboarding_id;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;
  insert into item_status_history (workspace_id, client_id, onboarding_id, item_id, from_status, to_status, actor_user_id, actor_role)
  values (new.workspace_id, new.client_id, new.onboarding_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
          app.uid(), nullif(app.role(), 'none'));
  if tg_op = 'INSERT' then
    return null;
  end if;
  evt := case
    when new.status = 'submitted' and new.kind = 'form' then 'form_submitted'
    when new.status = 'submitted' then 'item_submitted'
    when new.status = 'approved' and new.kind = 'task' then 'task_completed'
    when new.status = 'approved' and new.kind = 'file' then 'file_approved'
    when new.status = 'approved' then 'item_approved'
    when new.status = 'changes_requested' and new.kind = 'file' then 'file_rejected'
    when new.status = 'changes_requested' then 'item_changes_requested'
    else 'item_status_changed' end;
  insert into automation_events (workspace_id, type, client_id, onboarding_id, item_id, actor_user_id, payload)
  values (new.workspace_id, evt, new.client_id, new.onboarding_id, new.id, app.uid(),
          jsonb_build_object('itemKey', new.item_key, 'kind', new.kind, 'from', old.status, 'to', new.status, 'title', new.title));
  -- Items due "N days after their dependencies are approved" get their due date now.
  if new.status = 'approved' then
    update onboarding_items d
       set due_at = date_trunc('day', now()) + interval '17 hours' + ((d.config->>'dueAfterDependencyDays')::int * interval '1 day')
     where d.onboarding_id = new.onboarding_id and new.item_key = any(d.depends_on) and d.due_at is null
       and d.config ? 'dueAfterDependencyDays' and d.status <> 'approved'
       and not exists (select 1 from onboarding_items x where x.onboarding_id = d.onboarding_id and x.item_key = any(d.depends_on)
                       and x.removed_at is null and x.status <> 'approved' and x.id <> new.id);
  end if;
  if new.status = 'approved' and not exists (
      select 1 from onboarding_items i where i.onboarding_id = new.onboarding_id and i.required and i.removed_at is null
        and i.status <> 'approved') then
    insert into automation_events (workspace_id, type, client_id, onboarding_id, item_id, actor_user_id, payload)
    values (new.workspace_id, 'all_required_completed', new.client_id, new.onboarding_id, new.id, app.uid(), '{}');
  end if;
  return null;
end $$;
create trigger onboarding_items_events after insert or update of status on onboarding_items
  for each row execute function app.item_events();

create or replace function app.onboarding_events() returns trigger
  language plpgsql security definer set search_path = public, app as $$
declare
  evt text;
begin
  if tg_op = 'INSERT' then
    -- Historical records (imported as completed) don't start anything.
    evt := case when new.status = 'active' then 'onboarding_started' else null end;
  elsif new.kickoff_ready_at is not null and old.kickoff_ready_at is null then
    evt := 'ready_for_kickoff';
  elsif new.status is distinct from old.status then
    evt := case
      when new.status = 'paused' then 'onboarding_paused'
      when new.status = 'active' and old.status = 'paused' then 'onboarding_resumed'
      when new.status = 'completed' then 'onboarding_approved'
      when new.status = 'cancelled' then 'onboarding_cancelled'
      else null end;
  end if;
  if evt is not null then
    insert into automation_events (workspace_id, type, client_id, onboarding_id, actor_user_id, payload)
    values (new.workspace_id, evt, new.client_id, new.id, app.uid(), jsonb_build_object('status', new.status));
  end if;
  return null;
end $$;
create trigger onboardings_events after insert or update of status, kickoff_ready_at on onboardings
  for each row execute function app.onboarding_events();

create or replace function app.client_events() returns trigger
  language plpgsql security definer set search_path = public, app as $$
begin
  insert into automation_events (workspace_id, type, client_id, actor_user_id, payload)
  values (new.workspace_id, 'client_created', new.id, app.uid(), jsonb_build_object('source', new.source, 'name', new.name));
  return null;
end $$;
create trigger clients_events after insert on clients for each row execute function app.client_events();

create or replace function app.document_events() returns trigger
  language plpgsql security definer set search_path = public, app as $$
declare
  d record;
begin
  select item_id, onboarding_id into d from documents where id = new.document_id;
  if app.role() = 'client' then
    update onboardings set last_client_activity_at = now() where id = d.onboarding_id;
  end if;
  insert into automation_events (workspace_id, type, client_id, onboarding_id, item_id, actor_user_id, payload)
  values (new.workspace_id, 'file_uploaded', new.client_id, d.onboarding_id, d.item_id, app.uid(),
          jsonb_build_object('documentId', new.document_id, 'version', new.version, 'name', new.original_name));
  return null;
end $$;
create trigger document_versions_events after insert on document_versions
  for each row execute function app.document_events();

create or replace function app.comment_activity() returns trigger
  language plpgsql security definer set search_path = public, app as $$
begin
  if app.role() = 'client' then
    update onboardings set last_client_activity_at = now() where id = new.onboarding_id;
  end if;
  return null;
end $$;
create trigger comments_activity after insert on comments for each row execute function app.comment_activity();

-- ---------------------------------------------------------------------------
-- Notifications, integrations, webhooks, imports
-- ---------------------------------------------------------------------------

create table notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null default 'info',
  title text not null,
  body text,
  link text,
  onboarding_id uuid references onboardings(id) on delete cascade,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index on notifications (user_id, created_at desc);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'configured' check (status in ('configured', 'connected', 'error', 'disconnected')),
  config jsonb not null default '{}',
  secrets_enc text,
  connected_at timestamptz,
  connected_by uuid references users(id) on delete set null,
  last_tested_at timestamptz,
  last_event_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table integration_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null,
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  external_id text,
  event_type text not null,
  status text not null check (status in ('processed', 'ignored', 'failed', 'duplicate', 'simulated', 'skipped')),
  detail text,
  client_id uuid references clients(id) on delete set null,
  onboarding_id uuid references onboardings(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index integration_events_dedupe on integration_events (workspace_id, provider, external_id)
  where external_id is not null and direction = 'inbound' and status = 'processed';
create index on integration_events (workspace_id, created_at desc);

create table imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('clients', 'contacts', 'onboardings', 'tasks', 'requirements')),
  filename text not null,
  status text not null default 'uploaded' check (status in ('uploaded', 'completed', 'failed')),
  header text[] not null,
  rows jsonb not null,
  mapping jsonb not null default '{}',
  summary jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Shared rate limiting (accessed outside tenant context).
create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);

-- ---------------------------------------------------------------------------
-- Reminders, email and audit additions
-- ---------------------------------------------------------------------------

alter table reminder_rules
  add column item_scope text not null default 'all' check (item_scope in ('all', 'form', 'file', 'access', 'question', 'checklist', 'signature')),
  add column template_id uuid references templates(id) on delete cascade,
  add column notify_owner boolean not null default false,
  add column business_days_only boolean not null default true;

alter table email_messages drop constraint email_messages_status_check;
alter table email_messages add constraint email_messages_status_check
  check (status in ('scheduled', 'queued', 'sent', 'simulated', 'failed', 'skipped', 'cancelled'));
alter table email_messages drop constraint email_messages_kind_check;
alter table email_messages add constraint email_messages_kind_check
  check (kind in ('reminder', 'invitation', 'notification', 'escalation', 'automation'));
alter table email_messages
  add column send_after timestamptz,
  add column status_reason text,
  add column automation_run_id uuid references automation_runs(id) on delete set null;
create index email_messages_scheduled on email_messages (send_after) where status = 'scheduled';

alter table audit_events
  add column client_id uuid references clients(id) on delete set null,
  add column onboarding_id uuid references onboardings(id) on delete set null,
  add column category text;
create index on audit_events (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Grants and row-level security for new tables
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on client_types, client_contacts, automation_rules, automation_runs, automation_events,
  notifications, imports to clientflow_app;
grant select (id, workspace_id, provider, status, config, connected_at, connected_by, last_tested_at, last_event_at, last_error,
  created_at, updated_at) on integrations to clientflow_app;
grant insert (workspace_id, provider, status, config, connected_at, connected_by, last_tested_at, last_error, updated_at) on integrations to clientflow_app;
grant update (status, config, connected_at, connected_by, last_tested_at, last_event_at, last_error, updated_at) on integrations to clientflow_app;
grant delete on integrations to clientflow_app;
grant select, insert on integration_events, item_status_history to clientflow_app;
grant usage on sequence item_status_history_id_seq to clientflow_app;

alter table client_types enable row level security;
create policy ct_staff_read on client_types for select using (workspace_id = app.ws() and app.is_staff());
create policy ct_manager_write on client_types for all
  using (workspace_id = app.ws() and app.is_manager()) with check (workspace_id = app.ws() and app.is_manager());

alter table client_contacts enable row level security;
create policy cc_staff on client_contacts for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());
create policy cc_client_read on client_contacts for select
  using (workspace_id = app.ws() and app.role() = 'client' and client_id = app.client());

alter table item_status_history enable row level security;
create policy ish_staff on item_status_history for select using (workspace_id = app.ws() and app.is_staff());
create policy ish_insert on item_status_history for insert with check (workspace_id = app.ws());

alter table automation_events enable row level security;
create policy ae_staff on automation_events for all
  using (workspace_id = app.ws() and app.is_staff()) with check (workspace_id = app.ws() and app.is_staff());

alter table automation_rules enable row level security;
create policy ar_staff_read on automation_rules for select using (workspace_id = app.ws() and app.is_staff());
create policy ar_manager_write on automation_rules for all
  using (workspace_id = app.ws() and app.is_manager()) with check (workspace_id = app.ws() and app.is_manager());

alter table automation_runs enable row level security;
create policy arun_staff_read on automation_runs for select using (workspace_id = app.ws() and app.is_staff());
create policy arun_system_write on automation_runs for all
  using (workspace_id = app.ws() and app.role() = 'system') with check (workspace_id = app.ws() and app.role() = 'system');

alter table notifications enable row level security;
create policy notif_own on notifications for select using (workspace_id = app.ws() and user_id = app.uid());
create policy notif_own_update on notifications for update using (workspace_id = app.ws() and user_id = app.uid());
create policy notif_insert on notifications for insert with check (workspace_id = app.ws() and app.is_staff());
-- Staff and the engine notify other staff members, whose rows they cannot read back, so inserts go through
-- this function: it checks the caller is staff, the recipient is staff in the same workspace, and dedupes.
create or replace function app.create_notification(p_user uuid, p_kind text, p_title text, p_body text, p_link text,
  p_onboarding uuid, p_dedupe text) returns boolean
  language plpgsql security definer set search_path = public, app as $$
declare
  n integer;
begin
  if not app.is_staff() or app.ws() is null then
    raise exception 'only staff can create notifications';
  end if;
  if not exists (select 1 from memberships where workspace_id = app.ws() and user_id = p_user and role <> 'client') then
    return false;
  end if;
  if p_onboarding is not null and not exists (select 1 from onboardings where id = p_onboarding and workspace_id = app.ws()) then
    raise exception 'onboarding not in workspace';
  end if;
  insert into notifications (workspace_id, user_id, kind, title, body, link, onboarding_id, dedupe_key)
  values (app.ws(), p_user, coalesce(p_kind, 'info'), p_title, p_body, p_link, p_onboarding, p_dedupe)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;
grant execute on function app.create_notification(uuid, text, text, text, text, uuid, text) to clientflow_app;

alter table integrations enable row level security;
create policy int_staff_read on integrations for select using (workspace_id = app.ws() and app.is_staff());
create policy int_admin_write on integrations for all
  using (workspace_id = app.ws() and app.role() in ('admin', 'system'))
  with check (workspace_id = app.ws() and app.role() in ('admin', 'system'));

alter table integration_events enable row level security;
create policy ie_staff on integration_events for select using (workspace_id = app.ws() and app.is_staff());
create policy ie_insert on integration_events for insert with check (workspace_id = app.ws() and app.is_staff());

alter table imports enable row level security;
create policy imports_manager on imports for all
  using (workspace_id = app.ws() and app.is_manager()) with check (workspace_id = app.ws() and app.is_manager());

-- Reminder rules and escalation settings are manager-level configuration.
drop policy rr_staff on reminder_rules;
create policy rr_staff_read on reminder_rules for select using (workspace_id = app.ws() and app.is_staff());
create policy rr_manager_write on reminder_rules for all
  using (workspace_id = app.ws() and app.is_manager()) with check (workspace_id = app.ws() and app.is_manager());

-- Defense in depth: an onboarding can't be marked complete while required items are unapproved,
-- whichever code path tries (server actions check this too).
create or replace function app.onboarding_completion_guard() returns trigger
  language plpgsql security definer set search_path = public, app as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' and app.role() <> 'none'
     and exists (select 1 from onboarding_items i where i.onboarding_id = new.id and i.required
                 and i.removed_at is null and i.status <> 'approved') then
    raise exception 'This onboarding has required items that are not approved yet.';
  end if;
  return new;
end $$;
create trigger onboardings_completion_guard before update of status on onboardings
  for each row execute function app.onboarding_completion_guard();

-- People directory: staff see everyone in their workspace; clients see the team and their own company's contacts,
-- never other clients' users.
drop policy mem_read on memberships;
create policy mem_read on memberships for select using (
  workspace_id = app.ws() and (app.is_staff() or user_id = app.uid() or role <> 'client' or client_id = app.client()));
alter table users enable row level security;
create policy users_read on users for select using (
  id = app.uid() or exists (select 1 from memberships m where m.user_id = users.id and m.workspace_id = app.ws()));
