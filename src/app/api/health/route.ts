import { NextResponse } from "next/server";
import { sysQuery } from "@/lib/db";

export async function GET() {
  try {
    await sysQuery("select 1");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
