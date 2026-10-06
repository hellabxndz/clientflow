import { describe, it, expect, beforeAll } from "vitest";
import { uploadDocument, createDownloadLink, resolveDownload, checkFileAgainstRules } from "../src/lib/files";
import { signPayload } from "../src/lib/tokens";
import { withTenant, withSysTx } from "../src/lib/db";
import { makeWorkspace, itemByKey, PDF, type Fixture } from "./fixtures";

let w: Fixture;
let other: Fixture;
let guidelines: string; // accepts pdf
let versionId: string;

beforeAll(async () => {
  w = await makeWorkspace();
  other = await makeWorkspace();
  guidelines = (await itemByKey(w.clientA.onboardingId, "brand_guidelines")).id;
});

const tokenFrom = (url: string) => decodeURIComponent(url.split("t=")[1]);

describe("uploads", () => {
  it("a client can upload an allowed file to their own request, unscanned when no scanner is configured", async () => {
    const res = await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "brand.pdf", data: PDF });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scanStatus).toBe("not_scanned");
    versionId = res.versionId;
    const status = await itemByKey(w.clientA.onboardingId, "brand_guidelines");
    expect(status.status).toBe("in_progress");
  });

  it("enforces file type, size and content rules", async () => {
    expect((await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "run.exe", data: Buffer.from("MZ") })).ok).toBe(false);
    expect((await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "photo.png", data: PDF })).ok).toBe(false);
    const fake = await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "fake.pdf", data: Buffer.from("not a pdf") });
    expect(fake).toEqual({ ok: false, error: "The file content does not look like a valid .pdf file." });
    const big = checkFileAgainstRules({ name: "big.pdf", size: 60 * 1024 * 1024, data: PDF }, { accept: ["pdf"], maxSizeMb: 50 }, 25);
    expect(big).toMatch(/25 MB limit/);
  });

  it("enforces the per-request file count", async () => {
    // brand_guidelines allows 3 files; one uploaded above.
    await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "b2.pdf", data: PDF });
    await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "b3.pdf", data: PDF });
    const res = await uploadDocument(w.ctx.clientA, { itemId: guidelines, filename: "b4.pdf", data: PDF });
    expect(res.ok).toBe(false);
  });

  it("a new upload to an existing document becomes the next version", async () => {
    const docId = await withSysTx(async (tx) => (await tx.one<{ document_id: string }>("select document_id from document_versions where id = $1", [versionId]))!.document_id);
    const res = await uploadDocument(w.ctx.clientA, { itemId: guidelines, documentId: docId, filename: "brand-v2.pdf", data: PDF });
    expect(res.ok).toBe(true);
    const versions = await withSysTx((tx) => tx.q<{ version: number }>("select version from document_versions where document_id = $1 order by version", [docId]));
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("clients cannot upload to another client's request", async () => {
    const res = await uploadDocument(w.ctx.clientB, { itemId: guidelines, filename: "x.pdf", data: PDF });
    expect(res).toEqual({ ok: false, error: "Request not found." });
  });

  it("uploads are refused once a request is approved", async () => {
    const logo = await itemByKey(w.clientB.onboardingId, "brand_guidelines");
    await withSysTx((tx) => tx.q("update onboarding_items set status = 'approved' where id = $1", [logo.id]));
    const res = await uploadDocument(w.ctx.clientB, { itemId: logo.id, filename: "late.pdf", data: PDF });
    expect(res.ok).toBe(false);
  });
});

describe("download permissions", () => {
  it("the owning client and staff get short-lived links that work", async () => {
    const link = await createDownloadLink(w.ctx.clientA, versionId);
    expect(link).toMatch(/^\/api\/files\/download\?t=/);
    const file = await resolveDownload(w.ctx.clientA, tokenFrom(link!));
    expect(file?.data.equals(PDF)).toBe(true);
    const staffLink = await createDownloadLink(w.ctx.staff, versionId);
    expect(await resolveDownload(w.ctx.staff, tokenFrom(staffLink!))).not.toBeNull();
  });

  it("other clients and other workspaces cannot get a link", async () => {
    expect(await createDownloadLink(w.ctx.clientB, versionId)).toBeNull();
    expect(await createDownloadLink(other.ctx.admin, versionId)).toBeNull();
  });

  it("a link is bound to the user who requested it", async () => {
    const link = await createDownloadLink(w.ctx.clientA, versionId);
    expect(await resolveDownload(w.ctx.clientB, tokenFrom(link!))).toBeNull();
    expect(await resolveDownload(w.ctx.staff, tokenFrom(link!))).toBeNull();
  });

  it("expired or tampered links are rejected", async () => {
    const expired = signPayload({ v: versionId, u: w.ctx.clientA.userId, w: w.workspaceId }, -10);
    expect(await resolveDownload(w.ctx.clientA, expired)).toBeNull();
    const link = await createDownloadLink(w.ctx.clientA, versionId);
    const token = tokenFrom(link!);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: versionId, u: w.ctx.clientB.userId, w: w.workspaceId, exp: 9999999999 })).toString("base64url");
    expect(await resolveDownload(w.ctx.clientB, `${forged}.${sig}`)).toBeNull();
    expect(await resolveDownload(w.ctx.clientA, `${body}.x${sig.slice(1)}`)).toBeNull();
  });

  it("a client loses access to files on items hidden from them", async () => {
    await withSysTx((tx) => tx.q("update onboarding_items set audience = 'internal' where id = $1", [guidelines]));
    expect(await createDownloadLink(w.ctx.clientA, versionId)).toBeNull();
    await withSysTx((tx) => tx.q("update onboarding_items set audience = 'client' where id = $1", [guidelines]));
    expect(await withTenant(w.ctx.clientA, (tx) => tx.q("select id from document_versions"))).not.toHaveLength(0);
  });
});
