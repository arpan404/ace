import { createHash } from "node:crypto";

export type SkillErrorCode =
  | "not_found"
  | "conflict"
  | "exists"
  | "invalid"
  | "limit"
  | "read_only"
  | "update_failed"
  | "unavailable"
  | "busy";
/** A failure the person can act on; its message is shown as written. */
export class SkillError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
