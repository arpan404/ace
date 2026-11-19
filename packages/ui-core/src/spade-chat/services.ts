import { z } from "zod";
import { spadeJson } from "./json.ts";

/*
 * The processes a bot keeps running (ADR 0160): a dev server, a watcher. They are tools on its
 * computer, never work, so nothing here says the bot is busy. Parsed leniently: a service
 * without an id is left out, a state this client doesn't know reads as ended.
 */

/** Running, or how it ended: by itself, stopped, lost at a restart, or never started. */
export type SpadeServiceState = "running" | "exited" | "stopped" | "lost" | "failed" | "ended";

export interface SpadeService {
  id: string;
  name: string;
  /** Its command on one line, secrets taken out. */
  command: string;
  state: SpadeServiceState;
  exitCode: number | undefined;
}

const serviceShape = z.object({
  id: z.string().min(1),
  name: z.string().catch("").default(""),
  command: z.string().catch("").default(""),
  state: z
    .enum(["running", "exited", "stopped", "lost", "failed", "ended"])
    .catch("ended")
    .default("ended"),
  exit_code: z.number().int().nullish().catch(undefined),
});

const servicesShape = z.object({ services: z.array(z.unknown()) });

/** `{"services": [...]}`, oldest started first; undefined when the body has no list. */
export function parseSpadeServices(body: string): SpadeService[] | undefined {
  const parsed = servicesShape.safeParse(spadeJson(body));
  if (!parsed.success) return undefined;
  return parsed.data.services.flatMap((raw) => {
    const service = serviceShape.safeParse(raw);
    if (!service.success) return [];
    const { data } = service;
    return [
      {
        id: data.id,
        name: data.name || data.id,
        command: data.command,
        state: data.state,
        exitCode: data.exit_code ?? undefined,
      },
    ];
  });
}

/** A service's state in a few words: "Running", "Ended · exit 255", "Lost when Spade restarted". */
export function spadeServiceWords(service: SpadeService): string {
  switch (service.state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "lost":
      return "Lost when Spade restarted";
    case "failed":
      return "Couldn't start";
    default:
      return service.exitCode === undefined || service.exitCode === 0
        ? "Ended"
        : `Ended · exit ${service.exitCode}`;
  }
}

/** Some of a service's output, and where the next read starts (`after`). */
export interface SpadeServiceLines {
  lines: { n: number; text: string }[];
  next: number;
}

const linesShape = z.object({
  lines: z.array(z.object({ n: z.number(), text: z.string() })).catch([]),
  next: z.number().catch(0).default(0),
});

export function parseSpadeServiceLines(body: string): SpadeServiceLines | undefined {
  const parsed = linesShape.safeParse(spadeJson(body));
  if (!parsed.success) return undefined;
  return { lines: parsed.data.lines, next: parsed.data.next };
}
