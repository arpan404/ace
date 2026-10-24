import type { ClientCore } from "@ace/client";
import { submitCommand } from "./commands.ts";

/**
 * "No project" in New thread: Swift sends this in place of a project id. The thread starts in a
 * hidden chat project the daemon makes for it (ADR 0099).
 */
export const chatChoice = "chat";

/**
 * The hidden project the chat being written starts in: made through the outbox on first need
 * (a file attached, or Send) and kept until the thread starts or New thread closes, so its
 * files and its thread land in one folder. A failed make is forgotten, so the next need retries.
 */
export class ChatProject {
  readonly #owner: Pick<ClientCore, "commandId" | "intent" | "enqueue">;
  #made: Promise<string> | undefined;
  constructor(owner: Pick<ClientCore, "commandId" | "intent" | "enqueue">) {
    this.#owner = owner;
  }
  resolve(): Promise<string> {
    const made = (this.#made ??= this.#make());
    made.catch(() => {
      if (this.#made === made) this.#made = undefined;
    });
    return made;
  }
  /** The thread started in it, or New thread closed: the next chat gets its own folder. */
  release(): void {
    this.#made = undefined;
  }
  #make(): Promise<string> {
    return new Promise((resolve, reject) => {
      submitCommand(
        this.#owner,
        { type: "workspace.chat.create" },
        () => {},
        (result) => {
          if (result.ok && result.workspace) resolve(result.workspace.id);
          else reject(new Error(result.error ?? "chat_project_failed"));
        },
      ).catch(reject);
    });
  }
}
