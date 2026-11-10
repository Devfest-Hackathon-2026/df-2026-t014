export type GoogleErrorCode =
  | "CONFIG_REQUIRED"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AUTH_DENIED"
  | "POPUP_BLOCKED"
  | "NETWORK"
  | "API"
  | "CONFLICT"
  | "ACCOUNT_MISMATCH"
  | "AMBIGUOUS_WRITE"
  | "INVALID_DATA";

export class GoogleApiError extends Error {
  readonly code: GoogleErrorCode;
  readonly status?: number;

  constructor(code: GoogleErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GoogleApiError";
    this.code = code;
    this.status = status;
  }
}
