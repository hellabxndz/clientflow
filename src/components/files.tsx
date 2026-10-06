import { Badge } from "./ui";

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ScanBadge({ status }: { status: string }) {
  if (status === "clean") return <Badge tone="success">Scanned clean</Badge>;
  if (status === "infected") return <Badge tone="danger">Malware found</Badge>;
  if (status === "error") return <Badge tone="warning">Scan failed</Badge>;
  return <Badge tone="warning">Not scanned</Badge>;
}

export function ReviewBadge({ status }: { status: string }) {
  if (status === "approved") return <Badge tone="success">Accepted</Badge>;
  if (status === "changes_requested") return <Badge tone="danger">Changes requested</Badge>;
  return <Badge tone="info">Pending review</Badge>;
}
