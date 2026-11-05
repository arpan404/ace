/**
 * Typed access to `Bun.spawn` for the daemon's frequent short-lived processes (Git commands, CLI
 * probes). Bun's own `node:child_process` is built on the same call but wraps every pipe in
 * Node streams; going direct costs the daemon about a third less CPU per spawn. No Bun type
 * definitions are installed, so the part of the API used here is declared and checked at runtime.
 */

/** A piped stdin: `write` and `end` return a promise while bytes are still queued. */
export interface BunSink {
  write(chunk: string | Uint8Array): number | Promise<number>;
  end(): number | Promise<number>;
}

export interface BunSubprocess {
  readonly pid: number;
  readonly stdin: BunSink;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves once the process has exited; `exitCode`/`signalCode` are set by then. */
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
  unref(): void;
}

export interface BunSpawnOptions {
  cwd?: string | undefined;
  env: Record<string, string>;
  /** POSIX: the child leads a new session and process group, so the group can be killed. */
  detached?: boolean | undefined;
  windowsHide?: boolean | undefined;
  windowsVerbatimArguments?: boolean | undefined;
  /** Three pipes, then any descriptors the child inherits as fd 3, 4, … */
  stdio: ["pipe", "pipe", "pipe", ...number[]];
}

export interface BunSpawner {
  spawn(command: string[], options: BunSpawnOptions): BunSubprocess;
}

function hasSpawn(value: unknown): value is BunSpawner {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "spawn") === "function"
  );
}

/** Bun's spawner when this process runs on Bun, otherwise undefined. */
export function bunSpawner(): BunSpawner | undefined {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  return hasSpawn(bun) ? bun : undefined;
}

/** Bun's spawner; the daemon runs only on Bun, so its absence is a setup error. */
export function requireBunSpawner(): BunSpawner {
  const spawner = bunSpawner();
  if (!spawner) throw new Error("This process spawn needs the Bun runtime");
  return spawner;
}

/** Child environments carry only set variables. */
export function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}

/**
 * A failed `Bun.spawn` throws; Node reports the same failure as an `error` event carrying
 * `code`, `syscall` and `path`. Callers classify on `code`, so keep Bun's and fill the rest.
 */
export function spawnFailure(
  error: unknown,
  command: string,
  args: readonly string[],
): NodeJS.ErrnoException {
  const code =
    error instanceof Error && typeof Reflect.get(error, "code") === "string"
      ? String(Reflect.get(error, "code"))
      : "UNKNOWN";
  const errno = error instanceof Error ? Reflect.get(error, "errno") : undefined;
  return Object.assign(new Error(`spawn ${command} ${code}`, { cause: error }), {
    code,
    ...(typeof errno === "number" ? { errno } : {}),
    syscall: `spawn ${command}`,
    path: command,
    spawnargs: [...args],
  });
}

/** Bun hands out fresh chunks; view them as Buffers without copying. */
export function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}
