import type { CatalogEntry, ContentPart } from "@ace/protocol";
import { z } from "zod";

/*
 * The `/` menu in Spade's composer: built-in actions, the skills the bot may use and the commands
 * (manual skills) of the plugins it may use. A skill or command picked becomes a chip at the
 * start of the message, and the words after it are its arguments (`invoke` on the message).
 */

export type SlashKind = "skill" | "command";

/** One row of the menu. */
export interface SlashRow {
  kind: SlashKind;
  /** The skill's or command's id in Spade's skill store. */
  id: string;
  name: string;
  description: string;
  /** Where it comes from: `Spade`, a plugin's name. */
  source: string;
}

const invocables = z.object({
  invocables: z.array(
    z.object({
      kind: z.enum(["skill", "command"]),
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().catch(""),
      source: z.string().catch(""),
    }),
  ),
});

/** Spade's answer to `GET /v1/conversations/{id}/invocables`; undefined when it didn't parse. */
export function parseInvocables(value: unknown): SlashRow[] | undefined {
  const parsed = invocables.safeParse(value);
  return parsed.success ? parsed.data.invocables : undefined;
}

/** What the chip and message say: a skill's name as one word, as Spade's names are. */
export const slashLabel = (name: string) => `/${name.replace(/\s+/g, "-")}`;

const prefix = "spade:";

/** The catalog entry a skill or command's chip stands for, so the composer's own chip holds it. */
export function slashEntry(row: SlashRow): CatalogEntry {
  return {
    id: `${prefix}${row.kind}:${row.id}`,
    kind: row.kind === "command" ? "command" : "skill",
    name: row.name,
    description: row.description,
    source: { provider: "ace", scope: "ace" },
    invocation: { type: "slash", name: row.name },
  };
}

/** The skill or command a sent message started, read back from its chip. */
export function invokedIn(
  input: readonly ContentPart[] | undefined,
): { kind: SlashKind; id: string; name: string; args: string } | undefined {
  const first = input?.[0];
  if (first?.type !== "mention" || !first.entryId.startsWith(prefix)) return undefined;
  const [kind, ...id] = first.entryId.slice(prefix.length).split(":");
  if ((kind !== "skill" && kind !== "command") || !id.length) return undefined;
  // What follows the chip is its arguments.
  const args = (input ?? [])
    .slice(1)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  return { kind, id: id.join(":"), name: first.name, args };
}
