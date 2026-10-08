import { createHash } from "node:crypto";
import { z } from "zod";
import { CatalogEntry } from "@ace/protocol";
import type { ParsedSource, Target } from "./types.ts";

export const RuntimeExtensions = z.object({
  group: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/),
  catalog: z.array(CatalogEntry).max(512),
});
/** Harness lists are partitioned so an app update cannot erase a skill or command list. */
export function runtimeExtensions(
  input: unknown,
  target: Target,
): { source: string; parsed: ParsedSource } | undefined {
  const value = RuntimeExtensions.safeParse(input);
  if (!value.success) return undefined;
  const source = `runtime:${target.session}:${value.data.group}`;
  return {
    source,
    parsed: {
      diagnostics: [],
      commands: value.data.catalog.map((entry) => {
        const extension = entry;
        const id = `${source}#${createHash("sha256").update(entry.id).digest("hex").slice(0, 24)}`;
        return {
          id,
          name: id.replace(/[^\w.:-]/g, "-").slice(0, 128),
          nativeName: "name" in extension.invocation ? extension.invocation.name : extension.name,
          description: extension.description,
          namespace: "provider",
          provider: target.provider,
          instance: target.instance,
          session: target.session,
          scope: extension.source.scope === "project" ? "workspace" : "runtime",
          body: "",
          format: "runtime",
          raw: {},
          arguments: {},
          priority: 30 + (extension.source.scope === "project" ? 1 : 0),
          extension,
        };
      }),
    },
  };
}
