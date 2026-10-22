import { createHash } from "node:crypto";
import { CommandId, ThreadId, WorkspaceId, DeviceId } from "@ace/protocol";
import type { AutomationExecutor, ExecutionInput } from "@ace/automations";
import { z } from "zod";
import type { ServiceContext } from "./services/types.ts";
import { automationRunExecutor } from "./automation-run-executor.ts";

const deviceId = DeviceId.parse("automation");

/**
 * Runs a person's automation in its own one thread: the first run creates the thread, and every
 * later run sends its message into that same thread, queued behind any turn already going.
 */
export function automationExecutor(context: ServiceContext): AutomationExecutor {
  const { store } = context;
  store.atomic((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS automation_threads(
      automation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, settings TEXT
    );`),
  );
  const threadRow = (automationId: string) =>
    z
      .object({ thread_id: ThreadId, settings: z.string().nullable() })
      .optional()
      .parse(
        store
          .statement("SELECT thread_id,settings FROM automation_threads WHERE automation_id=?")
          .get(automationId),
      );
  /** The automation's thread while it can still take a run: not deleted, not archived. */
  const ownThread = (automationId: string): ThreadId | undefined => {
    const row = threadRow(automationId);
    const thread = row && store.getThread(row.thread_id);
    return thread && thread.deletedAt === undefined && thread.archivedAt === undefined
      ? thread.id
      : undefined;
  };
  const workspaceOf = (workspace: string) =>
    WorkspaceId.parse(
      store
        .statement("SELECT id FROM workspaces WHERE path=? OR id=? LIMIT 1")
        .get(workspace, workspace)?.id,
    );
  return automationRunExecutor(
    context,
    {
      deviceId,
      commandId: executionKey,
      admission(input) {
        const existing = ownThread(input.automationId);
        const origin = { kind: "automation" as const, role: input.automationId };
        if (existing)
          return {
            threadId: existing,
            payload: {
              type: "thread.send",
              threadId: existing,
              delivery: "queue",
              trigger: "schedule",
              origin,
              // The thread keeps whatever model and effort it has, unless the automation's own
              // changed since they were last given to it: then the run carries the new ones.
              ...runSettings(input, threadRow(input.automationId)?.settings ?? undefined),
              input: [{ type: "text", text: input.prompt }],
            },
          };
        return {
          payload: {
            type: "thread.create",
            workspaceId: workspaceOf(input.workspace),
            provider: input.provider,
            ...(input.access ? { access: input.access } : {}),
            trigger: "schedule",
            origin,
            ...(input.model ? { model: input.model } : {}),
            ...launchChoices(input),
            mode: input.worktree ? "worktree" : "local",
            title: automationThreadTitle(input.title),
            input: [{ type: "text", text: input.prompt }],
          },
        };
      },
      admitted(input, threadId) {
        const row = threadRow(input.automationId);
        const settings = settingsKey(input);
        if (row?.thread_id !== threadId || row.settings !== settings)
          store
            .statement(
              "INSERT INTO automation_threads VALUES (?,?,?) ON CONFLICT(automation_id) DO UPDATE SET thread_id=excluded.thread_id, settings=excluded.settings",
            )
            .run(input.automationId, threadId, settings);
      },
    },
    () => {
      const delegations = context.services.agentControl?.delegations;
      return delegations && ((thread, command) => delegations.hostStop(thread, command));
    },
  );
}

/** The automation's model and effort as one comparable value. */
const settingsKey = (input: Pick<ExecutionInput, "model" | "effort">) =>
  JSON.stringify({ model: input.model ?? null, effort: input.effort ?? null });

/**
 * The model and effort a run sends into the automation's existing thread. The thread keeps
 * whatever the person picked there, so a run sends nothing, unless the automation's own
 * settings changed since `applied` (what was last given to the thread): then it sends them.
 */
export function runSettings(
  input: Pick<ExecutionInput, "model" | "effort">,
  applied: string | undefined,
): { model?: string; options?: { effort: string } } {
  if (applied === settingsKey(input)) return {};
  return {
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { options: { effort: input.effort } } : {}),
  };
}

const executionKey = (value: string) =>
  CommandId.parse(`automation-${createHash("sha256").update(value).digest("hex")}`);

/**
 * The effort and account a run starts on, carried as New thread carries them: the account as
 * `accountId` (ACP agents are picked by their own identity, which an automation doesn't store)
 * and the effort in the launch options.
 */
export function launchChoices(input: ExecutionInput): {
  accountId?: string;
  options?: { effort: string };
} {
  return {
    ...(input.instance && input.provider !== "acp" ? { accountId: input.instance } : {}),
    ...(input.effort ? { options: { effort: input.effort } } : {}),
  };
}

/** "Automation: Nightly triage": the automation's own name, never its id. */
export function automationThreadTitle(name: string | undefined): string {
  const title = name?.trim();
  return title ? `Automation: ${title}`.slice(0, 256) : "Automation run";
}
