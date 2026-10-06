import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { resolveDownload } from "@/lib/files";

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return new NextResponse("Sign in required", { status: 401 });
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const file = await resolveDownload(tenantCtx(auth), token);
  if (!file) return new NextResponse("This download link is invalid or has expired.", { status: 404 });
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.data.length),
      "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
