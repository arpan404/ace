export type ForgeErrorKind =
  | "not_found"
  | "forbidden"
  | "rate_limit"
  | "invalid_data"
  | "limit"
  | "cli"
  | "cancelled"
  | "unsupported"
  | "conflict"
  | "outcome_uncertain"
  | "preferences_changed";
export class ForgeError extends Error {
  readonly kind: ForgeErrorKind;
  readonly retryAt: number | undefined;
  readonly dispatched: false | undefined;
  constructor(kind: ForgeErrorKind, retryAt?: number, dispatched?: false) {
    super(`Forge request failed: ${kind}`);
    this.name = "ForgeError";
    this.kind = kind;
    this.retryAt = retryAt;
    this.dispatched = dispatched;
  }
}
