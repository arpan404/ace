import { z } from "zod";

/*
 * Model servers on this computer (Ollama, LM Studio), as Spade finds them at their default ports
 * (`GET /v1/endpoints/local`): whether each runs, its models, and the endpoint the person already
 * added for it. Worded plainly ("Runs on this computer"). Pure.
 */

export interface SpadeLocalServer {
  /** `ollama` or `lmstudio`. */
  id: string;
  name: string;
  baseUrl: string;
  running: boolean;
  models: readonly string[];
  /** The endpoint already added at its address. */
  endpoint: string | undefined;
}

const server = z.object({
  id: z.string().min(1),
  name: z.string().catch(""),
  base_url: z.string().catch(""),
  running: z.boolean().catch(false),
  models: z.array(z.string()).catch([]),
  endpoint: z.string().nullish().catch(undefined),
});

/** The local servers; an entry this client can't read is left out. */
export function parseSpadeLocalServers(body: string): SpadeLocalServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const list = (raw as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const parsed = server.safeParse(item);
    if (!parsed.success) return [];
    const s = parsed.data;
    return [
      {
        id: s.id,
        name: s.name || s.id,
        baseUrl: s.base_url,
        running: s.running,
        models: s.models,
        endpoint: s.endpoint ?? undefined,
      },
    ];
  });
}

/** "Runs on this computer · 3 models", "Runs on this computer · no models yet", "Not running". */
export function spadeLocalServerWords(local: SpadeLocalServer): string {
  if (!local.running) return "Not running on this computer";
  const count = local.models.length;
  const models = count === 0 ? "no models yet" : count === 1 ? "1 model" : `${count} models`;
  return `Runs on this computer · ${models}`;
}

/**
 * The local models a picker offers apart from the person's endpoints: those of running servers
 * not added yet (an added one's models already show under its endpoint).
 */
export function spadeLocalChoices(
  servers: readonly SpadeLocalServer[],
): { server: SpadeLocalServer; model: string }[] {
  return servers
    .filter((local) => local.running && local.endpoint === undefined)
    .flatMap((local) => local.models.map((model) => ({ server: local, model })));
}
