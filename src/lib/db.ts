import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

const globalForPool = globalThis as unknown as { __cfPool?: Pool };

export const pool: Pool =
  globalForPool.__cfPool ?? new Pool({ connectionString: env.databaseUrl, max: 10 });
if (!env.isProduction) globalForPool.__cfPool = pool;

/**
 * Identity-level queries (users, sessions, invitations lookup). Never used for tenant data.
 */
export async function sysQuery<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export type TenantRole = "admin" | "staff" | "client" | "system";

export interface TenantContext {
  workspaceId: string;
  userId: string | null;
  role: TenantRole;
  clientId?: string | null;
}

export interface Tx {
  q<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>;
  client: PoolClient;
}

function wrap(client: PoolClient): Tx {
  return {
    client,
    async q(text, params = []) {
      return (await client.query(text, params)).rows;
    },
    async one(text, params = []) {
      return (await client.query(text, params)).rows[0] ?? null;
    },
  };
}

/**
 * Runs fn in a transaction as the restricted `clientflow_app` role with the tenant context
 * set, so Postgres row-level security enforces workspace and client isolation.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role clientflow_app");
    await client.query(
      `select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.role', $3, true), set_config('app.client_id', $4, true)`,
      [ctx.workspaceId, ctx.userId ?? "", ctx.role, ctx.role === "client" ? ctx.clientId ?? "" : ""],
    );
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Plain owner-level transaction, used only by migrations, seeding and auth flows. */
export async function withSysTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
