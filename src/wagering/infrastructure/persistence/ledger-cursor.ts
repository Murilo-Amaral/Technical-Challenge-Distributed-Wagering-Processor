import { ValidationError } from "../../application/errors";

/**
 * Opaque, stable ledger cursor: base64url of {"v":1,"s":"<sequence>"}. The sequence is a monotonic identity column,
 * so pages never shift when new entries are appended (keyset pagination, newest first).
 */
export function encodeLedgerCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: sequence })).toString("base64url");
}

export function decodeLedgerCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: number;
      s?: unknown;
    };
    if (parsed.v === 1 && typeof parsed.s === "string" && /^\d{1,19}$/.test(parsed.s)) {
      return parsed.s;
    }
  } catch {
    // fall through
  }
  throw new ValidationError("Invalid cursor", [
    { path: "cursor", message: "malformed or unsupported cursor" },
  ]);
}
