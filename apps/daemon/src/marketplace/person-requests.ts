import { z } from "zod";
import { ThreadId, type Command, type CommandResult, type InteractionRequest } from "@ace/protocol";
import { MarketOperation, type MarketResult, type MarketReview } from "@ace/protocol/marketplace";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import type { PersonAsk } from "./agent-gate.ts";

/*
 * A person-only market action an agent asked for (ADR 0176 §12.5): a request in the asking
 * thread's strip, in the person's words, with the action and Dismiss. Only a person's device
 * answers it (an agent or ace's reviewer is refused). The action then runs as the person, with
 * this machine's market grant, and what it did shows in the thread. Never starts a turn.
 */

const Row = z.object({
  interaction_id: z.string(),
  thread_id: z.string(),
  key: z.string(),
  operation: z.string(),
  hash: z.string().nullable(),
  prepare: z.string().nullable(),
});
type Row = z.infer<typeof Row>;

/** For an install: the review it came from, so an expired review is prepared again first. */
export interface ReviewedInstall {
  readonly review: MarketReview;
}

export interface MarketPersonRequestsDeps {
  readonly store: Store;
  engine(): Engine | undefined;
  id(): string;
  /** Runs an operation as the person: through the marketplace, with this machine's grant. */
  run(operation: MarketOperation): Promise<MarketResult>;
}

const RUN = "run";
const DISMISS = "dismiss";

export class MarketPersonRequests {
  private readonly deps: MarketPersonRequestsDeps;
  constructor(deps: MarketPersonRequestsDeps) {
    this.deps = deps;
    deps.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS market_person_pending (interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, key TEXT NOT NULL, operation TEXT NOT NULL, hash TEXT, prepare TEXT)",
      ),
    );
  }

  /** Opens the request in `threadId`'s strip; undefined when the thread isn't on this machine. */
  open(
    threadId: string,
    ask: PersonAsk,
    operation: MarketOperation,
    install?: ReviewedInstall,
  ): string | undefined {
    const engine = this.deps.engine();
    const thread = ThreadId.safeParse(threadId);
    if (!engine || !thread.success || !this.deps.store.getThread(thread.data)) return undefined;
    const key = `ace-market-ask:${this.deps.id()}`;
    const request: InteractionRequest = {
      kind: "approval",
      target: { tool: "market_publish", origin: "ace", access: "execute" },
      title: ask.title,
      options: [
        { id: RUN, label: ask.action, kind: "allow_once" },
        { id: DISMISS, label: "Dismiss", kind: "deny" },
      ],
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    };
    const interactionId = engine.openHostApproval(thread.data, key, request, [
      { type: "ace.market_person", data: { key } },
    ]);
    const prepare = install
      ? JSON.stringify({
          op: "prepare",
          source: install.review.source,
          type: install.review.type,
          name: install.review.name,
          version: install.review.version,
        } satisfies MarketOperation)
      : null;
    this.deps.store.atomic((db) =>
      db
        .prepare("INSERT INTO market_person_pending VALUES (?,?,?,?,?,?)")
        .run(
          interactionId,
          thread.data,
          key,
          JSON.stringify(operation),
          install?.review.hash ?? null,
          prepare,
        ),
    );
    return interactionId;
  }

  /** Whether `interactionId` is an open person-only market request. */
  isPending(interactionId: string): boolean {
    return (
      this.deps.store.atomic((db) =>
        db.prepare("SELECT 1 FROM market_person_pending WHERE interaction_id=?").get(interactionId),
      ) !== undefined
    );
  }

  /** Host-interaction hook: only a person's answer to an open market request is handled here. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return;
    const { interactionId, resolution } = command.payload;
    const found = this.deps.store.atomic((db) =>
      db.prepare("SELECT * FROM market_person_pending WHERE interaction_id=?").get(interactionId),
    );
    if (!found) return;
    const row = Row.parse(found);
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (["ace-reviewer", "ace-agent"].includes(command.deviceId))
      return fail("human_answer_required");
    if (resolution.kind !== "approval") return fail("invalid_resolution");
    const engine = this.deps.engine();
    if (!engine) return fail("engine_unavailable");
    const threadId = ThreadId.parse(row.thread_id);
    engine.resolveHostApproval(threadId, row.key, {
      state: "resolved",
      resolution,
      resolvedBy: command.deviceId,
    });
    this.deps.store.atomic((db) =>
      db.prepare("DELETE FROM market_person_pending WHERE interaction_id=?").run(interactionId),
    );
    if (resolution.optionId === RUN) void this.carryOut(threadId, row);
    return { commandId: command.id, ok: true };
  }

  private async carryOut(threadId: ThreadId, row: Row): Promise<void> {
    const engine = this.deps.engine();
    const notice = (text: string, level: "info" | "error") =>
      engine?.hostNotice(threadId, `${row.key}:done`, text, level);
    try {
      const operation = MarketOperation.safeParse(JSON.parse(row.operation));
      if (!operation.success) return notice("ace couldn't read this request any more.", "error");
      const result = await this.runReviewed(operation.data, row);
      if (result.op === "error") notice(result.message, "error");
      else notice(doneSentence(operation.data), "info");
    } catch (error) {
      // The thread may be gone by now; nothing else waits on this answer.
      try {
        notice(error instanceof Error ? error.message : "The market request failed.", "error");
      } catch {
        // No thread to say it in.
      }
    }
  }

  /** An install whose review expired is prepared again, and runs only on the same bytes. */
  private async runReviewed(operation: MarketOperation, row: Row): Promise<MarketResult> {
    const first = await this.deps.run(operation);
    if (operation.op !== "install" || first.op !== "error" || !row.prepare || !row.hash)
      return first;
    if (first.code !== "expired" && first.code !== "not_found") return first;
    const again = await this.deps.run(MarketOperation.parse(JSON.parse(row.prepare)));
    if (again.op !== "review") return again;
    if (again.review.hash !== row.hash)
      return {
        op: "error",
        code: "conflict",
        message: "Its files changed since the review, so nothing was installed.",
      };
    return this.deps.run({ ...operation, id: again.review.id });
  }
}

/** What the person's action did, as the thread's notice says it. */
export function doneSentence(operation: MarketOperation): string {
  if (operation.op === "install") return "Installed.";
  if (operation.op === "turnOn") return `${operation.type}/${operation.name} is back on.`;
  if (operation.op !== "publish") return "Done.";
  const request = operation.request;
  switch (request.action) {
    case "withdraw":
      return `Withdrawal of ${request.type}/${request.name}${request.version ? ` ${request.version}` : ""} taken; ace's signer signs it next.`;
    case "transfer":
      return `Offered ${request.type}/${request.name} to @${request.to}.`;
    case "transferAnswer":
      return request.accept ? "Transfer accepted." : "Transfer declined.";
    case "changeHandle":
      return `Your handle is @${request.handle}.`;
    case "deleteEntry":
      return `Deleted ${request.type}/${request.name}.`;
    case "draftPublish":
      return `Published draft ${request.id}.`;
    default:
      return "Done.";
  }
}
