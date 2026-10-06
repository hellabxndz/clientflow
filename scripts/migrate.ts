import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/lib/db";

export async function migrate(opts: { reset?: boolean; quiet?: boolean } = {}) {
  const client = await pool.connect();
  try {
    if (opts.reset) {
      await client.query("drop schema if exists public cascade; drop schema if exists app cascade; create schema public;");
      await client.query("grant all on schema public to public");
    }
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");
    await client.query("grant usage on schema public to public");
    const dir = path.join(process.cwd(), "db/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        if (!opts.quiet) console.log(`applied ${file}`);
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  migrate({ reset: process.argv.includes("--reset") })
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
