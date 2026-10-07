-- Account security: password reset links, authenticator-app MFA, and the scanning policy.
-- None of these tables is granted to clientflow_app: only server code running as the owner touches them.

create table password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  requested_ip text
);
create index on password_resets (user_id, created_at desc);
alter table password_resets enable row level security;

create table user_mfa (
  user_id uuid primary key references users(id) on delete cascade,
  -- AES-256-GCM encrypted TOTP secret (same key as integration credentials).
  secret_enc text not null,
  enabled_at timestamptz,
  -- Highest 30-second step accepted, so a code can't be replayed.
  last_step bigint not null default 0,
  recovery_hashes text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table user_mfa enable row level security;

alter table workspaces
  add column require_staff_mfa boolean not null default false,
  add column block_unscanned_uploads boolean not null default false;
grant update (require_staff_mfa, block_unscanned_uploads) on workspaces to clientflow_app;

alter table email_messages drop constraint email_messages_kind_check;
alter table email_messages add constraint email_messages_kind_check
  check (kind in ('reminder', 'invitation', 'notification', 'escalation', 'automation', 'security'));
-- Password reset emails are not tied to a workspace's outbox view.
alter table email_messages alter column workspace_id drop not null;
