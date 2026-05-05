import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type PiRpcId = string | number;

interface PiRpcResponse {
  readonly type: "response";
  readonly id?: PiRpcId;
  readonly command?: string;
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
}

export class PiRpcRequestError extends Error {
  constructor(
    readonly command: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PiRpcRequestError";
  }
}

export interface PiRpcEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiRpcRequestOptions {
  readonly timeoutMs?: number;
}

export interface PiRpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  request: (
    command: string,
    payload?: Record<string, unknown>,
    options?: PiRpcRequestOptions,
  ) => Promise<unknown>;
  notify: (command: string, payload?: Record<string, unknown>) => void;
  setEventHandler: (handler: (event: PiRpcEvent) => void) => void;
  setCloseHandler: (
    handler: (input: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void,
  ) => void;
  setProtocolErrorHandler: (handler: (error: Error) => void) => void;
  close: () => Promise<void>;
}

export interface StartPiRpcClientOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, payload: unknown): void {
  if (child.stdin.destroyed || !child.stdin.writable) {
    throw new Error("Pi RPC stdin is not writable.");
  }
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function asMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["details", "detail", "message", "error"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseResponse(value: unknown): PiRpcResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "response") {
    return undefined;
  }
  return {
    type: "response",
    ...(typeof record.id === "string" || typeof record.id === "number" ? { id: record.id } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.success === "boolean" ? { success: record.success } : {}),
    ...("data" in record ? { data: record.data } : {}),
    ...("error" in record ? { error: record.error } : {}),
  };
}

export function startPiRpcClient(options: StartPiRpcClientOptions): PiRpcClient {
  const child = spawn(options.binaryPath, [...options.args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      ...options.env,
    },
  });
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  const pending = new Map<PiRpcId, PendingRequest>();
  let nextRequestId = 1;
  let eventHandler: ((event: PiRpcEvent) => void) | undefined;
  let closeHandler:
    | ((input: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
    | undefined;
  let protocolErrorHandler: ((error: Error) => void) | undefined;

  const clearPending = (reason: Error) => {
    for (const [id, request] of pending.entries()) {
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
      pending.delete(id);
      request.reject(reason);
    }
  };

  const handleLine = (line: string) => {
    if (line.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      protocolErrorHandler?.(
        error instanceof Error
          ? error
          : new Error(`Failed to parse Pi RPC JSON line: ${String(error)}`),
      );
      return;
    }

    const response = parseResponse(parsed);
    if (response) {
      const requestId = response.id;
      if (requestId === undefined) {
        protocolErrorHandler?.(new Error("Received Pi RPC response without an id."));
        return;
      }
      const pendingRequest = pending.get(requestId);
      if (!pendingRequest) {
        return;
      }
      pending.delete(requestId);
      if (pendingRequest.timeout) {
        clearTimeout(pendingRequest.timeout);
      }
      if (response.success === false) {
        pendingRequest.reject(
          new PiRpcRequestError(
            pendingRequest.command,
            asMessage(response.error) ?? `Pi RPC command failed (${pendingRequest.command}).`,
            response.error,
          ),
        );
        return;
      }
      pendingRequest.resolve(response.data);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const event = parsed as Record<string, unknown>;
    if (typeof event.type !== "string") {
      return;
    }
    eventHandler?.(event as PiRpcEvent);
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      let line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      handleLine(line);
    }
  });

  child.stdout.on("end", () => {
    stdoutBuffer += decoder.end();
    if (stdoutBuffer.length > 0) {
      const line = stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer;
      handleLine(line);
      stdoutBuffer = "";
    }
  });

  child.on("error", (error) => {
    protocolErrorHandler?.(error);
    clearPending(error);
  });

  child.on("close", (code, signal) => {
    clearPending(
      new Error(`Pi RPC process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
    );
    closeHandler?.({ code, signal });
  });

  return {
    child,
    request(command, payload, options) {
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        const timeout =
          options?.timeoutMs !== undefined
            ? setTimeout(() => {
                pending.delete(id);
                reject(new PiRpcRequestError(command, `Pi RPC request timed out for ${command}.`));
              }, options.timeoutMs)
            : undefined;
        pending.set(id, {
          command,
          resolve,
          reject,
          ...(timeout ? { timeout } : {}),
        });
        try {
          writeJsonLine(child, {
            id,
            type: command,
            ...payload,
          });
        } catch (error) {
          pending.delete(id);
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(
            error instanceof Error
              ? error
              : new Error(`Failed to write Pi RPC request: ${String(error)}`),
          );
        }
      });
    },
    notify(command, payload) {
      try {
        writeJsonLine(child, {
          type: command,
          ...payload,
        });
      } catch (error) {
        protocolErrorHandler?.(
          error instanceof Error
            ? error
            : new Error(`Failed to write Pi RPC notification: ${String(error)}`),
        );
      }
    },
    setEventHandler(handler) {
      eventHandler = handler;
    },
    setCloseHandler(handler) {
      closeHandler = handler;
    },
    setProtocolErrorHandler(handler) {
      protocolErrorHandler = handler;
    },
    close() {
      return new Promise((resolve) => {
        let finished = false;
        const done = () => {
          if (finished) {
            return;
          }
          finished = true;
          resolve();
        };
        child.once("close", done);
        child.stdin.end();
        child.kill("SIGTERM");
        setTimeout(done, 2_000);
      });
    },
  };
}
