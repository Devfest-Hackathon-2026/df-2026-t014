/** Technical creation receipts only: no names, email, OAuth tokens, QR mappings, or PDF bytes. */
export interface CreationReceipt {
  fingerprint: string;
  id?: string;
  unknown: boolean;
}
const PREFIX = "paperflow-drive-create-v1:";

export function readCreationReceipt(key: string): CreationReceipt | undefined {
  try {
    const value = window.localStorage?.getItem(`${PREFIX}${key}`);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as Partial<CreationReceipt>;
    if (
      typeof parsed.fingerprint === "string" &&
      typeof parsed.unknown === "boolean" &&
      (parsed.id === undefined || typeof parsed.id === "string")
    )
      return {
        fingerprint: parsed.fingerprint,
        unknown: parsed.unknown,
        ...(parsed.id ? { id: parsed.id } : {}),
      };
  } catch {
    /* In private/blocked storage, the client still retains its in-memory receipt. */
  }
  return undefined;
}
export function writeCreationReceipt(
  key: string,
  value?: CreationReceipt,
): void {
  try {
    if (value)
      window.localStorage?.setItem(`${PREFIX}${key}`, JSON.stringify(value));
    else window.localStorage?.removeItem(`${PREFIX}${key}`);
  } catch {
    /* No school data or tokens are silently moved to another store. */
  }
}
