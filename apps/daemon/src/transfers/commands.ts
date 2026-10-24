import {
  HostId,
  type AgentId,
  type Command,
  type CommandResult,
  type ProviderKind,
  type Thread,
  type ThreadId,
  type Transfer,
  type WorkspaceId,
} from "@ace/protocol";
import { AsyncCommands } from "../async-commands.ts";
import type { Store } from "../store.ts";
import type { OutgoingTransfers } from "./outgoing.ts";
import { TransferError } from "./ports.ts";

export interface TransferCommandDeps {
  store: Store;
  outgoing: OutgoingTransfers;
  /** `remote.transferIgnoredFiles`: whether ignored files go when a transfer doesn't say. */
  ignoredByDefault(): Promise<boolean>;
  /** thread.move's refusal for a live tree; none when the thread may be carried. */
  continueRefusal(threadId: ThreadId): Promise<string | undefined>;
}

/** What a person reads for each refusal a thread's state gives (thread.move's checks). */
const refusalDetails: Record<string, string> = {
  thread_busy:
    "This thread is still working, waiting on you or has open terminals. Let it finish or stop it first.",
  thread_not_found: "That thread doesn't exist on this machine.",
  workspace_change_in_progress:
    "The thread's checkout is still being changed. Try again once that's done.",
  workspace_unavailable: "This machine's projects are still starting. Try again in a moment.",
};

export function refusalDetail(code: string): string {
  return refusalDetails[code] ?? "This thread can't be continued on another machine right now.";
}

/** Who asked: the person's own device, or an agent whose thread holds the transfer. */
export type TransferAsker =
  | { kind: "person" }
  | { kind: "agent"; threadId: ThreadId; agentId: AgentId; self: boolean };

export interface TransferInput {
  commandId: Command["id"];
  hostId: string;
  parent?: string | undefined;
  includeChanges: boolean;
  /** Omitted: this machine's `remote.transferIgnoredFiles`. */
  includeIgnored?: boolean | undefined;
  workspaceId?: WorkspaceId;
  threadId?: ThreadId;
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  asker: TransferAsker;
  hold?: ((transfer: Transfer) => void) | undefined;
}

/**
 * `workspace.transfer` and `thread.continueOn` (ADR 0099), with ADR 0057 admission and receipts:
 * the receipt is written once the transfer is accepted and running; its progress follows as
 * `transfer.progress`. The agents' `transfer` tool starts the same work.
 */
export class TransferCommands {
  private deps: TransferCommandDeps;
  private commands: AsyncCommands;
  constructor(deps: TransferCommandDeps) {
    this.deps = deps;
    this.commands = new AsyncCommands(deps.store);
  }
  execute(command: Command): Promise<CommandResult> {
    return this.commands.run(command, async () => {
      const p = command.payload;
      if (p.type !== "workspace.transfer" && p.type !== "thread.continueOn")
        return {
          ok: false,
          error: "invalid_command",
          code: "invalid_command",
          detail: "That isn't a transfer.",
        };
      try {
        await this.start({
          commandId: command.id,
          hostId: p.hostId,
          ...(p.parent ? { parent: p.parent } : {}),
          includeChanges: p.includeChanges,
          includeIgnored: p.includeIgnored,
          ...(p.type === "workspace.transfer"
            ? { workspaceId: p.workspaceId }
            : { threadId: p.threadId, provider: p.provider, model: p.model }),
          asker: { kind: "person" },
        });
        return { ok: true, ...(p.type === "thread.continueOn" ? { threadId: p.threadId } : {}) };
      } catch (error) {
        if (!(error instanceof TransferError)) throw error;
        return { ok: false, error: error.code, code: error.code, detail: error.message };
      }
    });
  }
  /** Checks what is asked and starts the transfer; a retry of the same command returns it. */
  async start(input: TransferInput): Promise<Transfer> {
    const { store } = this.deps;
    let thread: Thread | undefined;
    if (input.threadId) {
      thread = store.getThread(input.threadId);
      if (!thread || thread.deletedAt !== undefined)
        throw new TransferError("thread_not_found", "That thread doesn't exist.");
      // An agent continuing its own thread is that thread's live work; it hands over at commit.
      const self = input.asker.kind === "agent" && input.asker.self;
      if (!self) {
        const refused = await this.deps.continueRefusal(input.threadId);
        if (refused) throw new TransferError(refused, refusalDetail(refused));
      }
    }
    const workspaceId = thread?.workspaceId ?? input.workspaceId;
    if (!workspaceId) throw new TransferError("invalid", "Name a project or a thread.");
    const project = store.getWorkspace(workspaceId);
    const projectPath = store.getWorkspacePath(workspaceId);
    if (!project || !projectPath)
      throw new TransferError("workspace_not_found", "That project isn't on this machine.");
    const source = thread ? store.executionWorkspace(thread.id) : undefined;
    if (source && !source.ready)
      throw new TransferError("workspace_preparing", "The thread's checkout is still being made.");
    const target = await this.deps.outgoing.resolve(input.hostId);
    const includeIgnored = input.includeIgnored ?? (await this.deps.ignoredByDefault());
    const asker = input.asker;
    return this.deps.outgoing.start({
      commandId: input.commandId,
      kind: thread ? "thread" : "project",
      hold: input.hold,
      workspaceId,
      ...(thread ? { threadId: thread.id } : {}),
      source: source?.path ?? projectPath,
      name: project.name,
      target: { hostId: HostId.parse(input.hostId), name: target.name.slice(0, 256) || "machine" },
      request: {
        hostId: HostId.parse(input.hostId),
        profile: target.profile.name,
        ...(input.parent ? { parent: input.parent } : {}),
        includeChanges: input.includeChanges,
        includeIgnored,
        ...(thread
          ? {
              thread: {
                title: thread.title.slice(0, 256),
                mode: thread.details?.mode === "worktree" ? "worktree" : "local",
                provider: input.provider ?? thread.provider,
                ...(input.model
                  ? { model: input.model }
                  : !input.provider && thread.execution?.model
                    ? { model: thread.execution.model }
                    : {}),
              },
            }
          : {}),
        ...(asker.kind === "agent"
          ? { agent: { threadId: asker.threadId, agentId: asker.agentId, self: asker.self } }
          : {}),
      },
    });
  }
  drained(): Promise<void> {
    return this.commands.drained();
  }
}
