import { encodeSessionReference } from "@ace/adapter-pi/session-header";
import type { Source } from "./catalog.ts";

/** Pi resumes a saved file with its identity; other CLIs resume by session id. */
export function nativeReference(source: Source) {
  return {
    provider: source.summary.provider,
    nativeId:
      source.summary.provider === "pi"
        ? encodeSessionReference({ path: source.path, id: source.summary.nativeId })
        : source.summary.nativeId,
  };
}
