import { z } from "zod";

/*
 * An org host's audit export (ADR 0206 §4.2), read for the page, pure: a header naming the
 * organization, the host and its audit key, then each entry chained to the one before, each
 * checkpoint after the entry it covers. Lines this build doesn't know are kept out of the list,
 * never fatal. Checking the chain is Spade's (`ace org audit verify`), not this.
 */

const Ref = z.object({ type: z.string(), id: z.string(), name: z.string().optional() });
const Line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("header"), org: z.string(), host: z.string(), key: z.string() }),
  z.object({
    kind: z.literal("entry"),
    seq: z.number().int(),
    hash: z.string(),
    action: z.string(),
    occurred_at: z.number(),
    actor: Ref,
    targets: z.array(Ref),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ kind: z.literal("checkpoint"), count: z.number().int(), at: z.number() }),
]);

export interface AuditRow {
  seq: number;
  action: string;
  /** What happened, in words. */
  title: string;
  at: number;
  /** Who did it, by name where the entry has one. */
  actor: string;
  targets: string;
  /** Who allowed an outward step, when it says. */
  allowedBy: string | undefined;
}

const titles: Record<string, string> = {
  "bot.effect": "Outward step",
  "bot.approval.answered": "Request answered",
  "bot.created": "Shared bot made",
  "bot.configured": "Shared bot changed",
  "bot.access_changed": "Access changed",
  "bot.moved": "Bot moved",
  "bot.deleted": "Bot deleted",
  "package.installed": "Package installed",
  "package.updated": "Package updated",
  "package.rolled_back": "Package rolled back",
  "package.removed": "Package removed",
  "package.paused": "Package paused",
  "org.policy.changed": "Policy changed",
  "org.host.enrolled": "Host enrolled",
  "org.host.released": "Host released",
  "host.shell_opened": "Shell opened",
  "audit.checkpoint": "Checkpoint",
};

const named = (ref: z.infer<typeof Ref>) => ref.name || ref.id;

export function readAuditLines(text: string): {
  header: { org: string; host: string; key: string } | undefined;
  rows: AuditRow[];
  checkpoints: number;
} {
  let header: { org: string; host: string; key: string } | undefined;
  const rows: AuditRow[] = [];
  let checkpoints = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const line = Line.safeParse(value);
    if (!line.success) continue;
    const parsed = line.data;
    if (parsed.kind === "header") header = parsed;
    else if (parsed.kind === "checkpoint") checkpoints += 1;
    else {
      const by = parsed.metadata?.allowed_by_account;
      rows.push({
        seq: parsed.seq,
        action: parsed.action,
        title: titles[parsed.action] ?? parsed.action,
        at: parsed.occurred_at,
        actor: named(parsed.actor),
        targets: parsed.targets.map(named).join(", "),
        allowedBy: typeof by === "string" ? by : undefined,
      });
    }
  }
  return { header, rows, checkpoints };
}
