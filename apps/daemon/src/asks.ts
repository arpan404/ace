import { z } from "zod";
import {
  Command,
  ThreadId,
  type CommandResult,
  type InteractionRequest,
  type McpAttribution,
} from "@ace/protocol";
import type { AskInput, AskResult } from "@ace/mcp-server";
import type { Engine } from "./engine/index.ts";
import type { Store } from "./store.ts";
import { commandContext } from "./commands.ts";

const Pending = z.object({
  interaction_id: z.string(),
  thread_id: z.string(),
  key: z.string(),
  question: z.string(),
});
type Pending = z.infer<typeof Pending>;
type Answer = { status: "answered" | "declined"; answer: string[] };

/**
 * `ace_ask`: a question in the composer's strip, answered by the person. It waits a bounded
 * time; after that the tool returns pending and the person's answer arrives as their own next
 * message, so ace never starts a turn by itself. Agents can never answer it.
 */
export class Asks {
  private readonly waiters = new Map<string, (answer: Answer) => void>();
  private readonly deps: {
    store: Store;
    engine(): Engine | undefined;
    id(): string;
    schedule(run: () => void, ms: number): () => void;
  };
  constructor(deps: Asks["deps"]) {
    this.deps = deps;
    deps.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS ace_ask_pending (interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, key TEXT NOT NULL, question TEXT NOT NULL)",
      ),
    );
  }

  async ask(caller: McpAttribution, input: AskInput, signal: AbortSignal): Promise<AskResult> {
    const engine = this.deps.engine();
    if (!engine) throw new Error("Asking is unavailable");
    const threadId = ThreadId.parse(caller.threadId);
    const key = `ace-ask:${this.deps.id()}`;
    const request: InteractionRequest = {
      kind: "question",
      questions: [
        {
          id: "answer",
          text: input.question,
          options: (input.options ?? []).map((label, index) => ({ id: `o${index}`, label })),
          multiSelect: false,
          allowOther: input.allowOther || !input.options?.length,
        },
      ],
    };
    const interactionId = engine.openHostApproval(threadId, key, request, [
      { type: "ace.ask", data: { key } },
    ]);
    this.deps.store.atomic((db) =>
      db
        .prepare("INSERT INTO ace_ask_pending VALUES (?,?,?,?)")
        .run(interactionId, threadId, key, input.question.slice(0, 1000)),
    );
    const answer = await new Promise<Answer | undefined>((resolve) => {
      const finish = (value: Answer | undefined) => {
        cancel();
        signal.removeEventListener("abort", stop);
        this.waiters.delete(interactionId);
        resolve(value);
      };
      const stop = () => finish(undefined);
      const cancel = this.deps.schedule(stop, input.timeoutSeconds * 1000);
      this.waiters.set(interactionId, finish);
      signal.addEventListener("abort", stop, { once: true });
    });
    return answer
      ? { status: answer.status, askId: interactionId, answer: answer.answer }
      : { status: "pending", askId: interactionId };
  }

  /** Host-interaction hook: only a person's answer to a pending ace_ask is handled here. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return;
    const { interactionId, resolution } = command.payload;
    const row = this.deps.store.atomic((db) =>
      db.prepare("SELECT * FROM ace_ask_pending WHERE interaction_id=?").get(interactionId),
    );
    if (!row) return;
    const pending = Pending.parse(row);
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (["ace-reviewer", "ace-agent"].includes(command.deviceId))
      return fail("human_answer_required");
    if (resolution.kind !== "question") return fail("invalid_resolution");
    const engine = this.deps.engine();
    if (!engine) return fail("engine_unavailable");
    const threadId = ThreadId.parse(pending.thread_id);
    engine.resolveHostApproval(threadId, pending.key, {
      state: "resolved",
      resolution,
      resolvedBy: command.deviceId,
    });
    this.deps.store.atomic((db) =>
      db.prepare("DELETE FROM ace_ask_pending WHERE interaction_id=?").run(interactionId),
    );
    const interaction = this.deps.store.getInteraction(interactionId);
    const labels = new Map(
      interaction?.request.kind === "question"
        ? (interaction.request.questions[0]?.options ?? []).map((option) => [
            option.id,
            option.label,
          ])
        : [],
    );
    const answer: Answer = {
      status: resolution.dismissed ? "declined" : "answered",
      answer: (resolution.answers["answer"] ?? []).map((value) => labels.get(value) ?? value),
    };
    const waiter = this.waiters.get(interactionId);
    if (waiter) waiter(answer);
    else this.deliverLate(command, threadId, pending.question, answer);
    return { commandId: command.id, ok: true };
  }

  /** The tool already returned pending: the answer becomes the person's next message. */
  private deliverLate(command: Command, threadId: ThreadId, question: string, answer: Answer) {
    const engine = this.deps.engine();
    if (!engine) return;
    const text =
      answer.status === "declined"
        ? `I declined to answer "${question}".`
        : `My answer to "${question}": ${answer.answer.join(", ")}`;
    const send = Command.parse({
      id: `${command.id}:ask-answer`,
      deviceId: command.deviceId,
      payload: {
        type: "thread.send",
        threadId,
        delivery: "queue",
        input: [{ type: "text", text }],
      },
    });
    this.deps.store.recordCommand(send.id, send.deviceId, () =>
      engine.internalHandler.handle(send, commandContext(this.deps.store)),
    );
  }
}
