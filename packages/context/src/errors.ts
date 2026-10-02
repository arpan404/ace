import type { ContextErrorCode } from "@ace/protocol";
export class ContextError extends Error {
  readonly code: ContextErrorCode;
  constructor(code: ContextErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
export function requireContext(
  condition: unknown,
  code: ContextErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new ContextError(code, message);
}
