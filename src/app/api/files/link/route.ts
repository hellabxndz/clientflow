import { NextResponse, type NextRequest } from "next/server";
import { getAuth, mfaSetupRequired } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { createDownloadLink } from "@/lib/files";

/** Checks access, then redirects to a download URL that expires in five minutes. */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.redirect(new URL("/login", req.url));
  if (mfaSetupRequired(auth)) return NextResponse.redirect(new URL("/account?required=1", req.url));
  const versionId = req.nextUrl.searchParams.get("v") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return new NextResponse("Not found", { status: 404 });
  const link = await createDownloadLink(tenantCtx(auth), versionId);
  if (!link) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(new URL(link, req.url), { headers: { "Cache-Control": "no-store" } });
}
