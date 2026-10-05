import { z } from "zod";
import { NativeRef } from "./provider.ts";
import { Timestamp } from "./ids.ts";

/** The core thread's import source, independent of history service requests and responses. */
export const ImportedProvenance = z.object({
  sourceId: z.string().min(1),
  instanceId: z.string().min(1),
  native: NativeRef,
  importedAt: Timestamp,
});
export type ImportedProvenance = z.infer<typeof ImportedProvenance>;
