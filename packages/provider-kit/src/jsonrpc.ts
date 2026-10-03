import { rpcOwner } from "./rpc-owner.ts";
import { isRpcId as isId, type RpcId } from "./rpc-ids.ts";
import { byteLimit } from "./byte-limit.ts";
import { scheduleDeadline, type DeadlineScheduler } from "./rpc-timers.ts";
import { z } from "zod";
import type { SupervisedProcess } from "./process.ts";

export class MethodNotFound extends Error {
  constructor(message = "Method not found") {
    super(message);
    this.name = "MethodNotFound";
  }
}

export type { RpcId } from "./rpc-ids.ts";
export type { DeadlineScheduler } from "./rpc-timers.ts";
export type ServerRequest = { id: RpcId; method: string; params: unknown };
export type Notification = { method: string; params: unknown };
export type RpcOptions = {
  /** null disables the default deadline for interactive requests. */
  timeoutMs?: number | null;
  schedule?: DeadlineScheduler;
  maxPendingRequests?: number;
  maxIncomingRequests?: number;
  maxMessageBytes?: number;
  /** First peer configures the shared queued/in-flight byte cap for this pipe. */
  maxQueuedBytes?: number;
  /** First peer configures the pipe's lifetime reservation cap. Defaults to 4096. */
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
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
const RpcEnvelope = z.record(z.string(), z.unknown());
const noop = () => {};

/** Lenient stdio framing: extension methods and absent jsonrpc tags are accepted. */
export class JsonRpcPeer {
  readonly #process: SupervisedProcess;
  readonly #options: RpcOptions;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #owner: ReturnType<typeof rpcOwner>;
  readonly #outgoing = new AbortController();
  readonly #maxMessageBytes: number;
  readonly #maxPendingRequests: number;
  readonly #maxIncomingRequests: number;
  #incoming = 0;
  readonly #schedule: DeadlineScheduler;
  #closed: Error | undefined;
  onNotification: (message: Notification) => void = () => {};
  onRequest: (message: ServerRequest) => unknown | Promise<unknown> = () => {
    throw new MethodNotFound("unhandled request");
  };

  constructor(proc: SupervisedProcess, options: RpcOptions = {}) {
    this.#maxIncomingRequests = byteLimit(
      options.maxIncomingRequests ?? 128,
      "maxIncomingRequests",
    );
    this.#maxPendingRequests = byteLimit(options.maxPendingRequests ?? 256, "maxPendingRequests");
    this.#maxMessageBytes = byteLimit(
      options.maxMessageBytes ?? 16 * 1024 * 1024,
      "maxMessageBytes",
    );
    byteLimit(options.maxExplicitIds ?? 4096, "maxExplicitIds");
    byteLimit(options.maxQueuedBytes ?? 32 * 1024 * 1024, "maxQueuedBytes");
    this.#owner = rpcOwner(proc.stdin, options);
    this.#schedule = options.schedule ?? scheduleDeadline;
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
    const deadline =
      options.timeoutMs !== undefined
        ? options.timeoutMs
        : this.#options.timeoutMs !== undefined
          ? this.#options.timeoutMs
          : 30_000;
    if (deadline !== null && (!Number.isFinite(deadline) || deadline < 0)) {
      return Promise.reject(new RangeError("Invalid timeoutMs"));
    }
    let requestId: RpcId;
    try {
      requestId = this.#owner.ids.reserve(options.id);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise((resolve, reject) => {
      let cancelDeadline: () => void = noop;
      const writeAbort = new AbortController();
      const abort = () => this.#settle(requestId, asError(options.signal?.reason));
      const cleanup = () => {
        writeAbort.abort();
        cancelDeadline();
        options.signal?.removeEventListener("abort", abort);
      };
      this.#pending.set(requestId, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (deadline !== null) {
        try {
          const cancel = this.#schedule(deadline, () =>
            this.#settle(requestId, new Error(`JSON-RPC request timed out: ${method}`)),
          );
          if (this.#pending.has(requestId)) cancelDeadline = cancel;
          else {
            cancel();
            return;
          }
        } catch (error) {
          this.#settle(requestId, asError(error));
          return;
        }
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

  /** Reject admission/work while retaining final stdout observation until the pipe drains. */
  stopRequests(error = new Error("JSON-RPC peer closed")): void {
    this.#closed ??= error;
    this.#outgoing.abort(error);
    for (const id of this.#pending.keys()) this.#settle(id, error);
  }
  /** Dispose the peer without stopping its owning process. */
  close(error = new Error("JSON-RPC peer closed")): void {
    this.stopRequests(error);
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
    // Keep observing final stdout frames until close, but reject work at exit.
    this.stopRequests(error);
  };
  #report(error: Error): void {
    this.#options.onError?.(error);
  }
  #fail = (error: Error): void => {
    this.stopRequests(error);
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
    const bytes = Buffer.byteLength(line);
    if (bytes > this.#maxMessageBytes) throw new Error("JSON-RPC message exceeded limit");
    this.#options.onFrame?.("send", message);
    await this.#owner.writer.send(
      line,
      bytes,
      signal ? AbortSignal.any([signal, this.#outgoing.signal]) : this.#outgoing.signal,
    );
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
    const parsed = RpcEnvelope.safeParse(raw);
    if (!parsed.success) {
      this.#options.onMalformed?.(line);
      return;
    }
    const message = parsed.data;
    const id = message["id"];
    const method = message["method"];
    if (typeof method === "string" && isId(id)) {
      if (this.#closed) return;
      if (this.#incoming >= this.#maxIncomingRequests) {
        this.#fail(new Error("JSON-RPC incoming request limit"));
        return;
      }
      this.#incoming++;
      void this.#answer({ id, method, params: message["params"] }).finally(() => {
        this.#incoming--;
      });
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
