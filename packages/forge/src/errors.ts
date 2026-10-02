export type ForgeErrorKind =
  | "not_found"
  | "forbidden"
  | "rate_limit"
  | "invalid_data"
  | "limit"
  | "cli"
  | "cancelled"
  | "unsupported"
  | "conflict";
export class ForgeError extends Error {
  readonly kind: ForgeErrorKind;
  readonly retryAt: number | undefined;
  constructor(kind: ForgeErrorKind, retryAt?: number) {
    super(`Forge request failed: ${kind}`);
    this.name = "ForgeError";
    this.kind = kind;
    this.retryAt = retryAt;
  }
}
