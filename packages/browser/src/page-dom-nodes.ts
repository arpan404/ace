import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const DomCounters = z.object({ nodes: z.number() });
const Isolate = z.object({ id: z.string().min(1) });

/**
 * DOM nodes behind a page's frame sessions. `Memory.getDOMCounters` counts a whole renderer
 * process, and under site isolation many same-site frames share one process while each has its
 * own session, so each process is counted once, keyed by its V8 isolate. A session that cannot
 * name its isolate is counted on its own.
 */
export async function pageDomNodes(sessions: Iterable<BrowserCdp>): Promise<number> {
  const unique = [...new Set(sessions)];
  const keys = await Promise.all(
    unique.map(async (cdp): Promise<string | BrowserCdp> => {
      const named = Isolate.safeParse(await cdp.send("Runtime.getIsolateId").catch(() => null));
      return named.success ? named.data.id : cdp;
    }),
  );
  const processes = new Map<string | BrowserCdp, BrowserCdp>();
  unique.forEach((cdp, index) => {
    const key = keys[index] ?? cdp;
    if (!processes.has(key)) processes.set(key, cdp);
  });
  let nodes = 0;
  for (const cdp of processes.values())
    nodes += DomCounters.parse(await cdp.send("Memory.getDOMCounters")).nodes;
  return nodes;
}
