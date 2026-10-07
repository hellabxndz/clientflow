/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, embedded newlines, CRLF and a UTF-8 BOM. */
export function parseCsv(text: string, opts: { maxRows?: number } = {}): { header: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const delimiter = detectDelimiter(src);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") inQuotes = true;
    else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (opts.maxRows && records.length > opts.maxRows + 1) throw new Error(`The file has more than ${opts.maxRows} rows. Split it into smaller files.`);
    } else field += ch;
  }
  if (inQuotes) throw new Error("The file has an unclosed quote.");
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) throw new Error("The file is empty.");
  const header = nonEmpty[0].map((h) => h.trim());
  if (header.every((h) => !h)) throw new Error("The first row must contain column names.");
  const rows = nonEmpty.slice(1).map((r) => header.map((_, i) => (r[i] ?? "").trim()));
  return { header, rows };
}

function detectDelimiter(src: string) {
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ",";
}
