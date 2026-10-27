import type { ClientCore } from "@ace/client";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { z } from "zod";

/*
 * Open in, from the phone: the editors the machine running ace has, and opening a project's or
 * thread's folder, or a file in it, in one of them or the machine's file manager there
 * (`workspace.request` `host.open`). The phone has no editor of its own for the host's files.
 */

const quiet = { timeoutMs: 15_000 };

export const HostOpenRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("openers") }),
  z.object({
    op: z.literal("open"),
    app: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("editor"), editorId: z.string().min(1).max(128) }),
      z.object({ kind: z.literal("files") }),
    ]),
    workspaceId: WorkspaceId.optional(),
    threadId: ThreadId.optional(),
    path: z.string().min(1).max(4096).optional(),
    line: z.number().int().positive().optional(),
  }),
]);
export type HostOpenRequest = z.infer<typeof HostOpenRequest>;

const problems: Record<string, string> = {
  editor_not_found:
    "That editor isn't available to open from here on that computer. Show it in the file manager instead.",
  path_not_found: "That isn't on the machine any more.",
  workspace_not_found: "That project is gone.",
  forbidden: "This phone can only view this machine.",
};

export async function answerHostOpen(
  owner: Pick<ClientCore, "request">,
  request: HostOpenRequest,
): Promise<unknown> {
  try {
    if (request.op === "openers") {
      const reply = await owner.request(
        { type: "workspace.request", operation: { op: "editors.list" } },
        quiet,
      );
      const result = reply.result;
      if (result.kind !== "editors")
        return { ok: false, code: "unavailable", message: "Couldn't list the machine's editors." };
      return {
        ok: true,
        editors: result.editors.map((editor) => ({ id: editor.id, name: editor.name })),
        fileManager: result.fileManager ?? null,
      };
    }
    const { op: _, ...operation } = request;
    const reply = await owner.request(
      { type: "workspace.request", operation: { op: "host.open", ...operation } },
      quiet,
    );
    if (reply.result.kind === "opened") return { ok: true };
    const code = reply.result.kind === "error" ? reply.result.code : "unavailable";
    return { ok: false, code, message: problems[code] ?? "Couldn't open that on the machine." };
  } catch {
    return {
      ok: false,
      code: "unavailable",
      message: "Couldn't reach the machine. Update ace there if this keeps happening.",
    };
  }
}
