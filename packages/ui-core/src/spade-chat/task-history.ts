import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's task over time (spade/docs/agents.md): each version, who made it and why, as
 * `GET /v1/agents/{id}/task/history` answers them, newest first. Parsed leniently: a version this
 * client can't read is left out.
 */

export interface SpadeTaskVersion {
  /** The event that set it, unique within the bot. */
  seq: number;
  at: number;
  task: string;
  /** `person`, `bot`, or `made` for the task the bot started with (or one from before history). */
  by: "person" | "bot" | "made";
  why: string;
}

const version = z.object({
  seq: z.number(),
  at: z.number().catch(0),
  task: z.string(),
  by: z
    .string()
    .catch("")
    .transform((by): SpadeTaskVersion["by"] => (by === "person" || by === "bot" ? by : "made")),
  why: z.string().catch(""),
});

/** The versions, newest first; undefined when the body has no list. */
export function parseSpadeTaskHistory(body: string): SpadeTaskVersion[] | undefined {
  const list = spadeRecord(spadeJson(body))?.versions;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((raw) => {
    const parsed = version.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

/** One line of a task for a list: its first line, cut at `most` characters. */
export function spadeTaskFirstLine(task: string, most = 120): string {
  const line = task.trim().split("\n")[0]?.trim() ?? "";
  return line.length > most ? `${line.slice(0, most - 1).trimEnd()}…` : line;
}
