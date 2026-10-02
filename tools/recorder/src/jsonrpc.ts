import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Recording } from "./recording.ts";

type Id = number | string;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type ServerRequest = { id: Id; method: string; params: unknown };
export type Notification = { method: string; params: unknown };

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio. Records every
 * frame in both directions verbatim. Used for Codex app-server and ACP agents.
 */
export class JsonRpcPeer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #rec: Recording;
  readonly #pending = new Map<Id, Pending>();
  #nextId = 1;
  onNotification: (message: Notification) => void = () => {};
  /** Must return the `result` for a request from the other side. */
  onRequest: (message: ServerRequest) => Promise<unknown> = async () => {
    throw new Error("unhandled request");
  };

  constructor(child: ChildProcessWithoutNullStreams, rec: Recording) {
    this.#child = child;
    this.#rec = rec;
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    createInterface({ input: child.stderr }).on("line", (line) =>
      rec.frame("stderr", "stdio", line, false),
    );
    child.on("exit", (code, signal) => {
      rec.note("process-exit", { code, signal });
      for (const pending of this.#pending.values()) pending.reject(new Error("process exited"));
      this.#pending.clear();
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  #send(message: object): void {
    this.#rec.frame("send", "stdio", message);
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#rec.frame("recv", "stdio-text", line);
      return;
    }
    this.#rec.frame("recv", "stdio", message);
    const id = message["id"] as Id | undefined;
    const method = message["method"];
    if (typeof method === "string" && id !== undefined) {
      void this.#answer({ id, method, params: message["params"] });
    } else if (typeof method === "string") {
      this.onNotification({ method, params: message["params"] });
    } else if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (message["error"]) pending.reject(new Error(JSON.stringify(message["error"])));
      else pending.resolve(message["result"]);
    }
  }

  async #answer(request: ServerRequest): Promise<void> {
    try {
      const result = await this.onRequest(request);
      this.#send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
