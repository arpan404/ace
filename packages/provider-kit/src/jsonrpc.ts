import { RpcWriter } from "./rpc-writer.ts";
import { byteLimit } from "./output-budget.ts";
import type { SupervisedProcess } from "./process.ts";

export class MethodNotFound extends Error {
  constructor(message = "Method not found") {
    super(message);
    this.name = "MethodNotFound";
  }
}

export type RpcId = string | number;
export type ServerRequest = { id: RpcId; method: string; params: unknown };
export type Notification = { method: string; params: unknown };
export type RpcOptions = {
  /** null disables the default deadline for interactive requests. */
  timeoutMs?: number | null;
  maxPendingRequests?: number;
  maxMessageBytes?: number;
  maxQueuedBytes?: number;
  /** Explicit wire ids are never reused. Defaults to 4096 distinct explicit ids per peer. */
  maxExplicitIds?: number;
  onFrame?: (direction: "send" | "recv", message: unknown) => void;
  onMalformed?: (line: string) => void;
  onError?: (error: Error) => void;
};
export type RequestOptions = { timeoutMs?: number | null; signal?: AbortSignal; id?: RpcId };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
function isId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Lenient stdio framing: extension methods and absent jsonrpc tags are accepted. */
export class JsonRpcPeer {
  readonly #process: SupervisedProcess;
  readonly #options: RpcOptions;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #writer: RpcWriter;
  readonly #maxPendingRequests: number;
  readonly #maxExplicitIds: number;
  readonly #explicitIds = new Set<RpcId>();
  #nextId = 1;
  #closed: Error | undefined;
  onNotification: (message: Notification) => void = () => {};
  onRequest: (message: ServerRequest) => unknown | Promise<unknown> = () => {
    throw new MethodNotFound("unhandled request");
  };

  constructor(proc: SupervisedProcess, options: RpcOptions = {}) {
    this.#maxPendingRequests = byteLimit(options.maxPendingRequests ?? 256, "maxPendingRequests");
    this.#maxExplicitIds = byteLimit(options.maxExplicitIds ?? 4096, "maxExplicitIds");
    this.#writer = new RpcWriter(proc.stdin, options);
    this.#process = proc;
    this.#options = options;
    proc.stdout.on("line", this.#receive);
    proc.stdin.on("error", this.#fail);
    proc.signal.addEventListener("abort", this.#end, { once: true });
    proc.stdout.once("close", this.#drained);
    if (proc.signal.aborted) this.close(new Error("process exited"));
  }

  request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (options.signal?.aborted) return Promise.reject(asError(options.signal.reason));
    if (this.#pending.size >= this.#maxPendingRequests)
      return Promise.reject(new Error("JSON-RPC pending request limit"));
    let id = options.id;
    if (id !== undefined) {
      if (!isId(id) || (typeof id === "string" && Buffer.byteLength(id) > 1024))
        return Promise.reject(new Error("Invalid request id"));
      if (
        this.#explicitIds.has(id) ||
        (typeof id === "number" && Number.isInteger(id) && id > 0 && id < this.#nextId)
      )
        return Promise.reject(new Error("Request id already used"));
      if (this.#explicitIds.size >= this.#maxExplicitIds)
        return Promise.reject(new Error("JSON-RPC explicit id limit"));
    }
    const deadline =
      options.timeoutMs !== undefined
        ? options.timeoutMs
        : this.#options.timeoutMs !== undefined
          ? this.#options.timeoutMs
          : 30_000;
    if (deadline !== null && (!Number.isFinite(deadline) || deadline < 0)) {
      return Promise.reject(new RangeError("Invalid timeoutMs"));
    }
    if (id === undefined) {
      while (this.#explicitIds.has(this.#nextId)) this.#nextId++;
      if (!Number.isSafeInteger(this.#nextId))
        return Promise.reject(new Error("JSON-RPC id space exhausted"));
      id = this.#nextId++;
    } else this.#explicitIds.add(id);
    const requestId = id;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const writeAbort = new AbortController();
      const abort = () => this.#settle(requestId, asError(options.signal?.reason));
      const cleanup = () => {
        writeAbort.abort();
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.#pending.set(requestId, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (deadline !== null) {
        timer = setTimeout(
          () => this.#settle(requestId, new Error(`JSON-RPC request timed out: ${method}`)),
          deadline,
        );
      }
      void this.#send(
        {
          jsonrpc: "2.0",
          id: requestId,
          method,
          ...(params === undefined ? {} : { params }),
        },
        writeAbort.signal,
      ).catch((error: unknown) => this.#settle(requestId, asError(error)));
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    const sent = this.#send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
    void sent.catch((error: unknown) => this.#report(asError(error)));
    return sent;
  }

  /** Dispose the peer without stopping its owning process. */
  close(error = new Error("JSON-RPC peer closed")): void {
    this.#closed ??= error;
    this.#writer.close(error);
    this.#process.stdout.removeListener("close", this.#drained);
    this.#process.signal.removeEventListener("abort", this.#end);
    this.#process.stdout.removeListener("line", this.#receive);
    this.#process.stdin.removeListener("error", this.#fail);
    for (const id of this.#pending.keys()) this.#settle(id, error);
  }

  #drained = (): void => {
    this.close(new Error("process exited"));
  };
  #end = (): void => {
    const error = new Error("process exited");
    this.#closed ??= error;
    this.#writer.close(error);
    // Keep observing final stdout frames until close, but reject work at exit.
    for (const id of this.#pending.keys()) this.#settle(id, error);
  };
  #report(error: Error): void {
    this.#options.onError?.(error);
  }
  #fail = (error: Error): void => {
    this.close(error);
    this.#report(error);
  };
  #settle(id: RpcId, error?: Error, result?: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error);
    else pending.resolve(result);
  }
  async #send(message: object, signal?: AbortSignal): Promise<void> {
    if (this.#closed || this.#process.signal.aborted)
      throw this.#closed ?? new Error("process exited");
    const line = `${JSON.stringify(message)}\n`;
    this.#options.onFrame?.("send", message);
    await this.#writer.send(line, signal);
  }
  #receive = (line: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#options.onMalformed?.(line);
      return;
    }
    this.#options.onFrame?.("recv", raw);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.#options.onMalformed?.(line);
      return;
    }
    const message = raw as Record<string, unknown>;
    const id = message["id"];
    const method = message["method"];
    if (typeof method === "string" && isId(id)) {
      void this.#answer({ id, method, params: message["params"] });
    } else if (typeof method === "string" && id === undefined) {
      try {
        this.onNotification({ method, params: message["params"] });
      } catch (error) {
        this.#report(asError(error));
      }
    } else if (isId(id) && ("result" in message || "error" in message)) {
      this.#settle(
        id,
        message["error"] === undefined ? undefined : new Error(JSON.stringify(message["error"])),
        message["result"],
      );
    } else {
      this.#options.onMalformed?.(line);
    }
  };
  async #answer(request: ServerRequest): Promise<void> {
    let response: object;
    try {
      const result = await this.onRequest(request);
      response = { jsonrpc: "2.0", id: request.id, result: result ?? null };
    } catch (error) {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: error instanceof MethodNotFound ? -32601 : -32603,
          message: asError(error).message,
        },
      };
    }
    try {
      await this.#send(response);
    } catch (error) {
      if (!this.#closed) this.#report(asError(error));
    }
  }
}
