import {
  InteractionId,
  type Command,
  type CommandResult,
  type InteractionRequest,
  type InteractionResolution,
  type MachinePendingRequest,
  type ThreadId,
} from "@ace/protocol";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";

export interface MirrorDeps {
  store: Store;
  engine(): Engine | undefined;
  /** Forwards the person's answer to the machine that asked. */
  respond(
    entry: { machine: string; parentThreadId: ThreadId; remote: MachinePendingRequest },
    resolution: InteractionResolution,
  ): Promise<void>;
  log(message: string, fields: Record<string, unknown>): void;
}
interface Mirrored {
  source: string;
  machine: string;
  parentThreadId: ThreadId;
  key: string;
  localId: string;
  remote: MachinePendingRequest;
}

/** The machine's name on the request itself, so the strip says where it would run. */
export function labelled(request: InteractionRequest, name: string): InteractionRequest {
  switch (request.kind) {
    case "approval":
      return { ...request, title: `${name}: ${request.title}`.slice(0, 512) };
    case "question":
      return {
        ...request,
        questions: request.questions.map((question, index) =>
          index === 0 ? { ...question, text: `${name}: ${question.text}` } : question,
        ),
      };
    case "plan_review":
      return { ...request, title: `${name}: ${request.title ?? "Review the plan"}` };
    case "elicitation":
      return { ...request, title: `${name}: ${request.title ?? request.message}`.slice(0, 512) };
  }
}

/**
 * Requests that wait for the person on another machine appear in the originating thread here,
 * labelled with that machine, and the answer goes back to it. The machine that asked stays the
 * owner: answering there closes this copy on the next poll.
 */
export class RequestMirror {
  private deps: MirrorDeps;
  private open = new Map<string, Mirrored>();
  private forwarding = new Set<string>();
  private generation = 0;
  constructor(deps: MirrorDeps) {
    this.deps = deps;
  }
  /** Brings one source's copies in line with what the machine reports as open now. */
  sync(
    source: string,
    parentThreadId: ThreadId,
    machine: string,
    name: string,
    requests: readonly MachinePendingRequest[],
  ): void {
    const engine = this.deps.engine();
    if (!engine) return;
    const current = new Set(requests.map((request) => `${machine}:${request.interactionId}`));
    for (const [id, entry] of this.open)
      if (entry.source === source && !current.has(id)) this.close(id, entry);
    for (const remote of requests) {
      const id = `${machine}:${remote.interactionId}`;
      if (this.open.has(id) || this.forwarding.has(id) || this.open.size >= 64) continue;
      const key = `machine-request:${id}:${++this.generation}`;
      try {
        const localId = engine.openHostApproval(
          parentThreadId,
          key,
          labelled(remote.request, name),
          [
            {
              type: "ace.machine.request",
              data: { machine, threadId: remote.threadId, interactionId: remote.interactionId },
            },
          ],
        );
        this.open.set(id, { source, machine, parentThreadId, key, localId, remote });
      } catch (error) {
        this.deps.log("Machine request could not be shown", { machine, error: String(error) });
      }
    }
  }
  /** Closes every copy a source opened, when its call or child is over. */
  release(source: string): void {
    for (const [id, entry] of this.open) if (entry.source === source) this.close(id, entry);
  }
  private close(id: string, entry: Mirrored) {
    this.open.delete(id);
    if (this.deps.store.getInteraction(InteractionId.parse(entry.localId))?.state !== "pending")
      return;
    this.deps.engine()?.resolveHostApproval(entry.parentThreadId, entry.key, { state: "expired" });
  }
  /** The person answered the copy: close it here and forward the answer. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return undefined;
    const { interactionId, resolution } = command.payload;
    const found = [...this.open].find(([, entry]) => entry.localId === interactionId);
    if (!found) return undefined;
    const [id, entry] = found;
    this.open.delete(id);
    this.forwarding.add(id);
    this.deps.engine()?.resolveHostApproval(entry.parentThreadId, entry.key, {
      state: "resolved",
      resolution,
      resolvedBy: command.deviceId,
    });
    void this.deps
      .respond(entry, resolution)
      .catch((error: unknown) =>
        // Still open there: the next poll shows it here again.
        this.deps.log("Machine answer not delivered", {
          machine: entry.machine,
          error: String(error),
        }),
      )
      .finally(() => this.forwarding.delete(id));
    return { commandId: command.id, ok: true, threadId: entry.parentThreadId };
  }
}
