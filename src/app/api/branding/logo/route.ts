import { NextResponse } from "next/server";
import { getAuth } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { getStorage } from "@/lib/storage";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * The active workspace's uploaded logo, for any signed-in member (staff or client). Only raster
 * formats are ever stored (SVG uploads are rejected), and the response is locked down anyway.
 */
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ws = await withTenant(tenantCtx(auth), (tx) =>
    tx.one<{ logo_storage_key: string | null; logo_mime: string | null }>("select logo_storage_key, logo_mime from workspaces where id = $1", [auth.workspace.id]),
  );
  if (!ws?.logo_storage_key || !ws.logo_mime || !ALLOWED.has(ws.logo_mime)) return NextResponse.json({ error: "not found" }, { status: 404 });
  let data: Buffer;
  try {
    data = await getStorage().get(ws.logo_storage_key);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": ws.logo_mime,
      "Content-Length": String(data.length),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
