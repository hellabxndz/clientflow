# Deploying ClientFlow

ClientFlow keeps uploaded files on a private disk (`STORAGE_DIR`), so it needs a host that runs a long-lived
container with a persistent volume. Serverless hosts such as Vercel have no persistent disk: the seeded demo
documents and any uploads would be missing. Railway is the shortest path (app, Postgres and volume in one project);
the `Dockerfile` also runs on Render, Fly.io or any Docker host.

On start the container applies migrations, seeds the Northstar Growth Agency demo if it is missing, and starts the
app (`scripts/start-hosted.sh`). Demo workspaces never send real email.

## Railway

1. Sign in at railway.com with GitHub and create a project with **Deploy from GitHub repo** → `clientflow`.
   Railway reads `railway.json` and builds the `Dockerfile`.
2. In the project, **Create** → **Database** → **PostgreSQL**.
3. On the clientflow service: **Settings** → **Networking** → **Generate Domain**, target port `3000` (it must match `PORT` below).
4. Right-click the clientflow service → **Attach volume**, mount path `/data`.
5. On the clientflow service → **Variables**, add:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
   | `SESSION_SECRET` | 64 random hex characters (`openssl rand -hex 32`) |
   | `INTEGRATION_ENCRYPTION_KEY` | another 64 random hex characters |
   | `CRON_SECRET` | 48 random hex characters |
   | `PORT` | `3000` |

6. Deploy. The first boot takes a minute while it migrates and seeds. Sign in with
   `olivia@northstar.example.com` / `demo-password-123` (staff admin) or
   `john@johnsondental.example.com` / `demo-password-123` (client).

### Keeping the demo fresh

Prospects change the demo as they click around. To restore it, set `DEMO_RESET_ON_BOOT=true` and redeploy (or
restart): every start then wipes the database and reseeds. Remove the variable before the deployment holds real
data. `SEED_DEMO=false` skips the demo seed entirely.

### Optional

- Reminders and automations on a schedule: a Railway cron service (or any scheduler) calling
  `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every 5–15 minutes.
- Real email for non-demo workspaces: `RESEND_API_KEY` and `EMAIL_FROM` (see `.env.example`).
- AI assistant: `ANTHROPIC_API_KEY`.

Before real client documents go in, work through sections 11 and 12 of the README.
