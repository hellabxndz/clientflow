import type { CSSProperties } from "react";
import type { AuthContext } from "@/lib/auth";

const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

/** Portal branding derived from the workspace. Colors are validated so they can go into inline CSS variables safely. */
export function portalBrand(ws: AuthContext["workspace"]) {
  const brand = HEX.test(ws.brand_color) ? ws.brand_color : "#7647e8";
  const accent = HEX.test(ws.accent_color) ? ws.accent_color : "#a78bfa";
  const company = ws.name.replace(/\s*\(demo\)\s*$/i, "").trim() || ws.name;
  const name = ws.portal_name?.trim() || company;
  const monogram =
    name
      .replace(/\(.*\)/, "")
      .split(/\s+/)
      .filter((w) => /^[A-Za-z0-9]/.test(w))
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "•";
  const style = { "--brand": brand, "--accent": accent } as CSSProperties;
  return { brand, accent, company, name, monogram, style };
}
