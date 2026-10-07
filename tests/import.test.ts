import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/lib/db";
import { parseCsv } from "../src/lib/csv";
import { executeImport, guessMapping, validateImport } from "../src/lib/import";
import { makeWorkspace, type Fixture } from "./fixtures";

let w: Fixture;
beforeAll(async () => {
  w = await makeWorkspace();
});

describe("CSV parsing", () => {
  it("handles quotes, embedded commas and newlines, CRLF, BOM and semicolons", () => {
    const { header, rows } = parseCsv('﻿Name,Notes\r\n"Acme, Inc.","line 1\nline ""2"""\r\nBeta,\r\n');
    expect(header).toEqual(["Name", "Notes"]);
    expect(rows).toEqual([
      ["Acme, Inc.", 'line 1\nline "2"'],
      ["Beta", ""],
    ]);
    expect(parseCsv("a;b\n1;2").rows).toEqual([["1", "2"]]);
  });

  it("rejects unclosed quotes, empty files and oversized files", () => {
    expect(() => parseCsv('a,b\n"open,1')).toThrow(/unclosed quote/);
    expect(() => parseCsv("\n\n")).toThrow(/empty/);
    expect(() => parseCsv("a\n1\n2\n3\n4", { maxRows: 2 })).toThrow(/more than 2 rows/);
  });

  it("guesses column mapping from common spreadsheet headers", () => {
    const m = guessMapping("clients", ["Company Name", "Primary Contact", "Email", "Account Manager", "MRR"]);
    expect(m).toEqual({ name: 0, contact_name: 1, contact_email: 2, account_manager: 3, deal_amount: 4 });
  });
});

describe("client import", () => {
  const header = ["Company", "Email", "Website", "Time zone"];
  const csvRows = [
    ["Client A", "someone@new.example.com", "", ""], // same name as an existing client
    ["Northwind Bakery", "hello@northwind.example.com", "https://northwind.example.com", "America/Chicago"],
    ["northwind bakery", "other@northwind.example.com", "", ""], // duplicate inside the file
    ["", "x@example.com", "", ""], // missing name
    ["Bad Email Co", "not-an-email", "", "Mars/Olympus"],
  ];
  const mapping = () => guessMapping("clients", header);

  it("validates rows and detects duplicates without writing anything", async () => {
    const { results, missingRequired } = await withTenant(w.ctx.admin, (tx) => validateImport(tx, "clients", csvRows, mapping()));
    expect(missingRequired).toEqual([]);
    expect(results[0].duplicate).toBe("existing");
    expect(results[1].errors).toEqual([]);
    expect(results[1].action).toBe("create");
    expect(results[2].duplicate).toBe("in_file");
    expect(results[3].errors.join(" ")).toMatch(/missing/i);
    expect(results[4].errors.join(" ")).toMatch(/email|time zone/i);
    const count = await withTenant(w.ctx.admin, (tx) => tx.one<{ n: number }>("select count(*)::int as n from clients"));
    expect(count!.n).toBe(2);
  });

  it("refuses to import until required columns are mapped", async () => {
    await expect(withTenant(w.ctx.admin, (tx) => executeImport(tx, w.ctx.admin, "clients", csvRows, { contact_email: 1 }))).rejects.toThrow(/required columns/);
  });

  it("imports only valid, non-duplicate rows and reports the rest", async () => {
    const summary = await withTenant(w.ctx.admin, (tx) => executeImport(tx, w.ctx.admin, "clients", csvRows, mapping()));
    expect(summary.created).toBe(1);
    expect(summary.skippedDuplicates).toBe(2);
    expect(summary.failed + summary.errors.length).toBeGreaterThanOrEqual(2);
    const names = await withTenant(w.ctx.admin, (tx) => tx.q<{ name: string; source: string }>("select name, source from clients order by name"));
    expect(names.find((c) => c.name === "Northwind Bakery")?.source).toBe("csv");
    // Running the same file again creates nothing new.
    const again = await withTenant(w.ctx.admin, (tx) => executeImport(tx, w.ctx.admin, "clients", csvRows, mapping()));
    expect(again.created).toBe(0);
  });

  it("imports stay inside the importer's workspace", async () => {
    const other = await makeWorkspace();
    const before = await withTenant(other.ctx.admin, (tx) => tx.q("select id from clients"));
    await withTenant(w.ctx.admin, (tx) => executeImport(tx, w.ctx.admin, "clients", [["Isolated Co", "", "", ""]], mapping()));
    const after = await withTenant(other.ctx.admin, (tx) => tx.q("select id from clients"));
    expect(after).toHaveLength(before.length);
  });
});
