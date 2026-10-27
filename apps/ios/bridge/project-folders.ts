import type { ClientCore } from "@ace/client";
import { SettingsValues } from "@ace/protocol";
import { folderName, projectProblem } from "@ace/ui-core";
import { z } from "zod";
import type { WriteOutcome } from "./project-manage.ts";

/*
 * The folders a machine may open projects in (`projects.roots`), as the web's Settings › Project
 * folders: list them, allow another (a leading `~` read as that machine's home; a missing one
 * offered for creating), or stop allowing one. Allowing goes through the durable outbox
 * (`workspace.root.add`); removing rewrites the setting.
 */

const quiet = { timeoutMs: 15_000 };

export const FolderRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("roots") }),
  z.object({
    op: z.literal("allowFolder"),
    path: z.string().min(1).max(4096),
    create: z.boolean().default(false),
  }),
  z.object({ op: z.literal("removeFolder"), path: z.string().min(1).max(4096) }),
]);
export type FolderRequest = z.infer<typeof FolderRequest>;

export type FoldersOwner = Pick<ClientCore, "request">;

/** A typed path the machine could take: absolute, `~`, or a Windows drive. */
export function folderPathProblem(typed: string): string | undefined {
  return /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(typed.trim())
    ? undefined
    : "Use the folder's full path, such as ~/code or /Users/you/code.";
}

export class ProjectFolders {
  readonly #owner: FoldersOwner;
  readonly #write: (raw: unknown) => Promise<WriteOutcome>;
  constructor(owner: FoldersOwner, write: (raw: unknown) => Promise<WriteOutcome>) {
    this.#owner = owner;
    this.#write = write;
  }

  async answer(request: FolderRequest): Promise<unknown> {
    switch (request.op) {
      case "roots": {
        const roots = await this.#roots();
        return {
          ok: true,
          folders: roots.map((path) => ({ path, name: folderName(path) || "Projects" })),
        };
      }
      case "allowFolder": {
        const problem = folderPathProblem(request.path);
        if (problem) return { ok: false, code: "invalid_path", message: problem };
        const path = await this.#resolve(request.path.trim());
        if (path === undefined)
          return { ok: false, code: "unavailable", message: projectProblem("unavailable").message };
        const outcome = await this.#write({
          type: "workspace.root.add",
          path,
          ...(request.create ? { create: true } : {}),
        });
        // A missing folder is offered for creating, under the path the machine resolved.
        return outcome.ok
          ? outcome
          : {
              ...outcome,
              path,
              name: folderName(path),
              canCreate: outcome.code === "directory_missing",
            };
      }
      case "removeFolder": {
        const roots = await this.#roots();
        const value = SettingsValues.shape["projects.roots"].parse(
          roots.filter((root) => root !== request.path),
        );
        const reply = await this.#owner.request(
          { type: "settings.set", key: "projects.roots", value, layer: { kind: "global" } },
          quiet,
        );
        return reply.ok
          ? { ok: true, queued: false }
          : {
              ok: false,
              code: "invalid",
              message: reply.diagnostics[0]?.message ?? "Couldn't save allowed folders. Try again.",
            };
      }
    }
  }

  async #roots(): Promise<string[]> {
    const reply = await this.#owner.request(
      { type: "settings.get", key: "projects.roots", scope: {} },
      quiet,
    );
    const value = reply.entries.find((entry) => entry.key === "projects.roots")?.value;
    return z.array(z.string()).catch([]).parse(value);
  }

  /** `~` and `~/…` on the machine's own home; anything else as typed. */
  async #resolve(typed: string): Promise<string | undefined> {
    if (typed !== "~" && !typed.startsWith("~/")) return typed;
    const reply = await this.#owner
      .request({ type: "projects.request", operation: { op: "fs.home" } }, quiet)
      .catch(() => undefined);
    const result = reply?.result;
    if (result?.kind !== "home") return undefined;
    const home = result.path.replace(/\/+$/, "");
    return typed === "~" ? result.path : `${home}/${typed.slice(2)}`.replace(/\/+$/, "");
  }
}
