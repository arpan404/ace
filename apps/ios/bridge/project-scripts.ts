import type { ClientCore } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { WriteOutcome } from "./project-manage.ts";

/*
 * A thread's project scripts, as the web's work card Run menu: the scripts the daemon found
 * (package.json, Makefile, justfile, Procfile) with the files that configure them, and running
 * one in a terminal. A script whose terminal still runs is shown again instead of starting a
 * second copy fighting the first for its port.
 */

const quiet = { timeoutMs: 15_000 };

export const ScriptRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("scripts"), threadId: ThreadId }),
  z.object({
    op: z.literal("runScript"),
    threadId: ThreadId,
    scriptId: z.string().min(1).max(128),
  }),
  /** The thread's dev servers the daemon detected, to open in its browser. */
  z.object({ op: z.literal("previews"), threadId: ThreadId }),
]);
export type ScriptRequest = z.infer<typeof ScriptRequest>;

export type ScriptsOwner = Pick<ClientCore, "request">;

export class ProjectScripts {
  readonly #owner: ScriptsOwner;
  readonly #write: (raw: unknown) => Promise<WriteOutcome>;
  constructor(owner: ScriptsOwner, write: (raw: unknown) => Promise<WriteOutcome>) {
    this.#owner = owner;
    this.#write = write;
  }

  async answer(request: ScriptRequest): Promise<unknown> {
    if (request.op === "previews") return this.#previews(request.threadId);
    try {
      const [scripts, running] = await Promise.all([
        this.#scripts(request.threadId),
        this.#running(request.threadId),
      ]);
      if (request.op === "scripts")
        return {
          ok: true,
          scripts: scripts.map((script) => ({
            id: script.id,
            name: script.name,
            command: script.command.slice(0, 1024),
            source: script.source,
            running: running.has(script.name),
          })),
          // The files to edit to change them, as the web's "Edit package.json scripts".
          files: [...new Set(scripts.map((script) => script.source))],
        };
      const script = scripts.find((entry) => entry.id === request.scriptId);
      if (!script) return { ok: false, message: "That script isn't in the project any more." };
      const already = running.get(script.name);
      if (already) return { ok: true, terminalId: already, reused: true };
      const outcome = await this.#write({
        type: "workspace.script.run",
        threadId: request.threadId,
        scriptId: script.id,
      });
      if (!outcome.ok)
        return { ok: false, message: `Couldn't run ${script.command}: ${outcome.message}` };
      return { ok: true, terminalId: outcome.terminalId ?? null, reused: false };
    } catch {
      return { ok: false, message: "Couldn't read the project's scripts. Try again." };
    }
  }

  async #previews(threadId: ThreadId) {
    try {
      const reply = await this.#owner.request(
        { type: "preview.request", threadId, operation: { op: "list", suggestions: true } },
        quiet,
      );
      if (!reply.ok) return { ok: false, message: "Couldn't read the thread's dev servers." };
      const seen = new Set<number>();
      const rows = [
        ...(reply.suggestions ?? []).map((found) => ({
          port: found.port,
          url: found.url,
          title: found.title ?? `localhost:${found.port}`,
        })),
        ...(reply.previews ?? []).map((preview) => ({
          port: preview.port,
          url: `http://localhost:${preview.port}`,
          title: `localhost:${preview.port}`,
        })),
      ].filter((row) => !seen.has(row.port) && seen.add(row.port));
      return { ok: true, previews: rows.slice(0, 32) };
    } catch {
      return { ok: false, message: "Couldn't read the thread's dev servers." };
    }
  }

  async #scripts(threadId: ThreadId) {
    const reply = await this.#owner.request(
      { type: "workspace.request", operation: { op: "scripts.list", threadId } },
      quiet,
    );
    if (reply.result.kind !== "scripts") throw new Error("unavailable");
    return reply.result.scripts;
  }

  /** Terminals still running, by name: a script's terminal is named after it. */
  async #running(threadId: ThreadId): Promise<Map<string, string>> {
    const reply = await this.#owner
      .request({ type: "terminal.request", operation: { op: "list", threadId } }, quiet)
      .catch(() => undefined);
    return new Map(
      (reply?.terminals ?? [])
        .filter((terminal) => !terminal.exited)
        .map((terminal) => [terminal.name, terminal.id] as const),
    );
  }
}
