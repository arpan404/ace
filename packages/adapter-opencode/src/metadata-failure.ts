import type { DiscoveryFailureCode } from "@ace/provider-kit/discovery-failure";

/** Classified HTTP failures must survive the client's generic Transport wrapper. */
export class MetadataResponseError extends Error {
  readonly code: DiscoveryFailureCode;
  readonly detail: string | undefined;
  constructor(path: string, code: DiscoveryFailureCode, detail?: string) {
    super(`OpenCode metadata response failed at ${path}`);
    this.code = code;
    this.detail = detail === undefined ? undefined : `${path}: ${detail}`;
  }
}

/** Only unwrap our classified response errors, never arbitrary provider codes. */
export function metadataFailure(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 12; depth++) {
    if (current instanceof MetadataResponseError) return current;
    if (!(current instanceof Error)) break;
    current = current.cause;
  }
  return error;
}
