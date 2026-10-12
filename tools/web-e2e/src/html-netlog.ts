import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const netlog = z.object({
  constants: z.object({ logEventTypes: z.record(z.string(), z.number().int()) }),
  events: z.array(
    z.object({
      type: z.number().int(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
/** Observe Chromium's resolver, including DNS-only hints that never produce an HTTP request. */
export async function resolverLookups(path: string): Promise<string[]> {
  if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error("NetLog exceeds fixture limit");
  const log = netlog.parse(JSON.parse(await readFile(path, "utf8")));
  const resolverTypes = new Set(
    Object.entries(log.constants.logEventTypes)
      .filter(([name]) => /^HOST_RESOLVER.*(?:REQUEST|JOB)$/.test(name))
      .map(([, value]) => value),
  );
  return log.events.flatMap((event) => {
    if (!resolverTypes.has(event.type)) return [];
    const host = event.params?.host ?? event.params?.hostname;
    return typeof host === "string" ? [host] : [];
  });
}
