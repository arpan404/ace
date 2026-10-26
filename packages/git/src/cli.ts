import {
  mutationLeaseId,
  assertAvailable,
  captureMutationOwnership,
  recoverMutationLeases,
  mutationState,
  clearStaleLeases,
  healRepository,
  settleOwnLeases,
  type LeaseProbe,
} from "./mutation-leases.ts";
import { clearLeftoverLocks, lockGraceMs } from "./git-locks.ts";
import { runningChildren } from "./git-processes.ts";
import type { CleanupResult } from "@ace/provider-kit/cleanup";
import { z } from "zod";
import { isUtf8 } from "node:buffer";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  executionKeyQuery,
  hooklessEnv,
  nonExecutingEnv,
  nonExecutingTransportEnv,
  transportEnv,
} from "./non-executing.ts";
import { credentialHelperArgs, systemCredentialConfigFile } from "./credential-helpers.ts";
import { userTransportConfig } from "./transport-config.ts";
import { hooksInsideCheckout } from "./reviewer-hooks.ts";
import { Readable, type Writable } from "node:stream";
import { drainProcessExit, killTree, processRuntime } from "./process-runtime.ts";
import { StringDecoder } from "node:string_decoder";
import { realpath, stat } from "node:fs/promises";
import { GitDiagnostics } from "./diagnostics.ts";
import { failureMessage, StderrTail } from "./failure-text.ts";
import { spawnPinned } from "./pinned-process.ts";
import { windowsHooklessArgs, windowsHooklessEnv } from "./disabled-hooks.ts";
import { windowsLongPathsEnv } from "./disabled-hooks.ts";
import { count, decode } from "./decode.ts";
import { ConfigFacts, configEnvironment } from "./config-facts.ts";
import { learnConfigSources, standardConfigFiles } from "./config-learning.ts";
import {
  GitError,
  toGitError,
  type GitOptions,
  type GitProcessRuntime,
  type GitCredentialHelperLookup,
  type GitCredentialHelper,
} from "./types.ts";

interface CallOptions {
  directoryFd?: number | undefined;
  beforeSpawn?: (() => void) | undefined;
  signal?: AbortSignal | undefined;
  stderr?: (chunk: Buffer) => void;
  write?: boolean;
  env?: Record<string, string>;
  input?: Buffer | string | Readable;
  output?: Writable;
  allowFailure?: boolean;
  captureBytes?: number;
  consume?: (chunk: Buffer) => void;
  /** This call's deadline, instead of the service's `timeoutMs`. */
  timeoutMs?: number;
}

export interface Output {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export class GitCli {
  private readonly protectedWorktrees = new Set<string>();
  private readonly person = new AsyncLocalStorage<"person" | "reviewer">();
  private readonly executionPolicy = new AsyncLocalStorage<
    "non-executing" | { protocols: readonly string[] }
  >();
  private readonly transportProtocols: readonly string[];
  private readonly credentialHelperLookup: GitCredentialHelperLookup | undefined;
  private readonly credentialConfigPaths: {
    system: string | undefined;
    xdg: string;
    global: string;
  };
  readonly leaseId: () => string;
  readonly leaseProbe: LeaseProbe;
  private readonly now: () => Date | Promise<Date>;
  /** The executable the caller configured, if any; else `git` or what it would launch. */
  private readonly configuredBinary: string | undefined;
  private resolvedBinary: string | undefined;
  readonly timeoutMs: number;
  private readonly facts: ConfigFacts;
  private readonly standardFiles = new Map<string, Promise<string[] | undefined>>();
  private ready: Promise<void> | undefined;
  private readonly runtime: GitProcessRuntime;
  private readonly calls = new Set<Promise<Output>>();
  private readonly cancellations = new Set<() => void>();
  private readonly drains = new Set<Promise<void>>();
  /** Leases of processes this service killed, retired once their process groups are gone. */
  private readonly killed = new Set<string>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: GitOptions) {
    this.transportProtocols = options.transportProtocols ?? ["http", "https", "ssh"];
    this.credentialHelperLookup = options.credentialHelperLookup;
    const home = process.env.HOME || homedir();
    const paths = {
      system: options.credentialConfigPaths?.system,
      xdg:
        options.credentialConfigPaths?.xdg ??
        join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config"),
      global: options.credentialConfigPaths?.global ?? join(home, ".gitconfig"),
    };
    for (const path of Object.values(paths)) {
      if (path !== undefined && (!path || path.includes("\0")))
        throw new GitError("invalid_argument", "Invalid user credential config path");
    }
    // Git resolves --file relative to the checkout. Resolve daemon-selected paths here so a
    // relative XDG setting cannot accidentally select an agent-controlled file there.
    this.credentialConfigPaths = {
      system: paths.system === undefined ? undefined : resolvePath(paths.system),
      xdg: resolvePath(paths.xdg),
      global: resolvePath(paths.global),
    };
    this.runtime = processRuntime(options.processRuntime);
    this.leaseId = options.leaseId ?? mutationLeaseId;
    this.now = options.now ?? (() => new Date());
    this.leaseProbe = {
      schedule: this.runtime.scheduleTimeout,
      retired: options.onLeaseRetired,
      // A cleanup supervisor owns the proof that killed writers stopped; never second-guess it.
      evidence: this.runtime.cleanupSupervisor
        ? undefined
        : {
            processes: this.runtime.gitProcesses,
            groupAlive: this.runtime.groupAlive,
            now: this.now,
          },
      waitMs: options.leaseWaitMs ?? 60_000,
    };
    this.configuredBinary = options.gitBinary;
    if (
      this.configuredBinary !== undefined &&
      (!this.configuredBinary || this.configuredBinary.includes("\0"))
    ) {
      throw new GitError("invalid_argument", "gitBinary must name an executable");
    }
    this.facts = new ConfigFacts({
      now: this.runtime.fileClock,
      sources: (cwd, env) => this.configSources(cwd, env),
    });
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new GitError(
        "invalid_argument",
        "timeoutMs must be an integer between 1 and 2147483647",
      );
    }
  }

  assertMutationAvailable(path: string) {
    return assertAvailable(path, this.leaseProbe);
  }
  mutationState(path: string) {
    return mutationState(path, this.leaseProbe);
  }
  clearStaleLeases(path: string) {
    return clearStaleLeases(path, this.leaseProbe);
  }
  /** Retire stale leases and remove Git lock files no live Git process holds. */
  heal(path: string) {
    return healRepository(path, this.leaseProbe);
  }
  recoverCleanup(path: string) {
    return recoverMutationLeases(
      path,
      (lease) =>
        this.runtime.cleanupSupervisor?.recover(lease) ??
        Promise.resolve({
          status: "unconfirmed",
          reason: "No escaped-descendant containment supervisor",
        }),
      this.leaseProbe,
    );
  }

  protectWorktree(path: string): void {
    this.protectedWorktrees.add(resolvePath(path));
  }
  forgetWorktree(path: string): void {
    this.protectedWorktrees.delete(resolvePath(path));
  }
  private protectedPath(path: string): boolean {
    let current = resolvePath(path);
    for (;;) {
      if (this.protectedWorktrees.has(current)) return true;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
  nonExecuting<T>(operation: () => Promise<T>): Promise<T> {
    // Automatic work nested in a person's operation is still automatic.
    return this.person.exit(() => this.executionPolicy.run("non-executing", operation));
  }
  /**
   * A commit or push the person asked for: it runs their hooks and signing as their own Git
   * would, even in a protected root. Nested `nonExecuting` scopes stay guarded.
   */
  asPerson<T>(operation: () => Promise<T>): Promise<T> {
    return this.person.run("person", operation);
  }
  /**
   * As `asPerson`, in a checkout holding someone else's code (a pull request under review).
   * Hooks that live inside that checkout are its author's programs, so there no hook runs.
   */
  asReviewer<T>(operation: () => Promise<T>): Promise<T> {
    return this.person.run("reviewer", operation);
  }
  /**
   * ace's own reads inside a person's operation (status, config, refs) are not commands the
   * person ran: they keep the checkout's usual protections. Only their `add`, `commit` and
   * `push` run as their Git would.
   */
  bookkeeping<T>(operation: () => Promise<T>): Promise<T> {
    return this.person.exit(operation);
  }
  private personScope(): "person" | "reviewer" | undefined {
    return this.executionPolicy.getStore() === "non-executing" ? undefined : this.person.getStore();
  }
  executionDisabledAt(path: string): boolean {
    const policy = this.executionPolicy.getStore();
    return policy === "non-executing" || (this.protectedPath(path) && !this.personScope());
  }
  /** Whether a hook Git would run in the checkout at `cwd` lives inside it. */
  hooksInsideCheckout(cwd: string, signal?: AbortSignal): Promise<boolean> {
    return hooksInsideCheckout(
      (args) =>
        this.executeRaw(cwd, args, {
          captureBytes: 65_536,
          allowFailure: true,
          ...(signal ? { signal } : {}),
        }),
      cwd,
    );
  }
  get activeCalls(): number {
    return this.calls.size;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const cancel of this.cancellations) cancel();
    this.closing = Promise.allSettled(this.calls)
      .then(() => Promise.allSettled(this.drains))
      // Killed processes' leaders have exited: retire the leases whose groups are gone now,
      // so shutdown leaves nothing behind that it could have settled.
      .then(() => settleOwnLeases([...this.killed], this.leaseProbe, 1))
      .then(
        () => {},
        () => {},
      );
    return this.closing;
  }
  call(cwd: string, args: string[], options: CallOptions = {}): Promise<Output> {
    if (this.closed) return Promise.reject(new GitError("git_closed", "Git service closed"));
    if (this.calls.size >= 64)
      return Promise.reject(new GitError("git_busy", "Git call limit reached"));
    const result = this.runCall(cwd, args, options);
    this.calls.add(result);
    void result.then(
      () => this.calls.delete(result),
      () => this.calls.delete(result),
    );
    return result;
  }
  /** A user-admitted fetch retains all tree execution guards, including in protected roots. */
  fetch(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (args[0] !== "fetch")
      return Promise.reject(new GitError("invalid_argument", "Explicit fetch requires fetch"));
    return this.executionPolicy.run({ protocols: this.transportProtocols }, () =>
      this.call(cwd, args, options),
    );
  }
  /**
   * Fetch from a bundle file ace wrote or received. Git reads bundles through its `file`
   * transport, so this call alone allows `file`; the caller validates the bundle path first
   * (see `transfer-bundle-file.ts`), and every other transport stays closed.
   */
  fetchBundle(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (args[0] !== "fetch")
      return Promise.reject(new GitError("invalid_argument", "Bundle fetch requires fetch"));
    return this.executionPolicy.run({ protocols: ["file"] }, () => this.call(cwd, args, options));
  }
  /** Publishing has its own admission path; local plumbing never inherits transport permission. */
  push(
    cwd: string,
    args: string[],
    options: CallOptions,
    protocols: readonly string[] = this.transportProtocols,
  ): Promise<Output> {
    if (args[0] !== "push")
      return Promise.reject(new GitError("invalid_argument", "Explicit push requires push"));
    // A person's push runs their pre-push hook and push signing. Submodules are never pushed
    // along: they go to other remotes ace has not checked.
    const guards = this.personScope() ? [] : ["--no-verify", "--signed=false"];
    return this.executionPolicy.run({ protocols }, () =>
      this.call(cwd, ["push", ...guards, "--recurse-submodules=no", ...args.slice(1)], options),
    );
  }
  /** Read a remote's branches through exactly the transport a push from `cwd` would use. */
  lsRemote(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (args[0] !== "ls-remote")
      return Promise.reject(new GitError("invalid_argument", "Remote probe requires ls-remote"));
    return this.executionPolicy.run({ protocols: this.transportProtocols }, () =>
      this.call(cwd, args, options),
    );
  }
  /** Cancellable I/O-bound retry pause, using the same injected clock as calls. */
  pause(milliseconds: number): Promise<void> {
    if (this.closed) return Promise.reject(new GitError("git_closed", "Git service closed"));
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        stop();
        this.cancellations.delete(cancelled);
        reject(new GitError("git_closed", "Git service closed"));
      };
      const stop = this.runtime.scheduleTimeout(() => {
        this.cancellations.delete(cancelled);
        resolve();
      }, milliseconds);
      this.cancellations.add(cancelled);
    });
  }
  private async runCall(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (args.some((arg) => arg.includes("\0"))) {
      throw new GitError("invalid_argument", "Git arguments cannot contain NUL bytes");
    }
    await assertAvailable(cwd, this.leaseProbe);
    await this.ensureReady(cwd, options.directoryFd, options.signal);
    options.signal?.throwIfAborted();
    await assertAvailable(cwd, this.leaseProbe);
    try {
      return await this.execute(cwd, args, options);
    } catch (error) {
      // A lock file left by a killed or crashed Git process: remove it once no Git process can
      // hold it and it predates this call, then retry once.
      const lock = error instanceof GitError ? error.details.lock : undefined;
      const evidence = this.leaseProbe.evidence;
      if (!options.write || typeof lock !== "string" || !evidence) throw error;
      const target = join(await realpath(dirname(lock)).catch(() => dirname(lock)), basename(lock));
      // Only a lock older than the grace period: a Git command starting now keeps its own.
      const before = new Date((await this.now()).getTime() - lockGraceMs);
      const removed = await clearLeftoverLocks(cwd, evidence.processes, before).catch(
        (): string[] => [],
      );
      if (!removed.includes(target)) throw error;
      options.signal?.throwIfAborted();
      return this.execute(cwd, args, options);
    }
  }

  /** The platform Git runs on, for Windows-only repository settings. */
  get platform(): NodeJS.Platform {
    return this.runtime.platform;
  }

  /** The executable each Git call starts. */
  get binary(): string {
    return this.configuredBinary ?? this.resolvedBinary ?? "git";
  }

  private ensureReady(cwd: string, directoryFd?: number, signal?: AbortSignal): Promise<void> {
    this.ready ??= this.verify(cwd, directoryFd, signal).catch((error: unknown) => {
      this.ready = undefined;
      this.resolvedBinary = undefined;
      throw error;
    });
    return this.ready;
  }

  private async verify(cwd: string, directoryFd?: number, signal?: AbortSignal): Promise<void> {
    // Resolved once per verification; a missing executable later re-verifies (see `executeRaw`).
    if (this.configuredBinary === undefined)
      this.resolvedBinary = await this.runtime.locateGit(inheritedEnv()).catch(() => undefined);
    // Windows searches a bare name in the working directory, a checkout, before PATH.
    if (
      this.runtime.platform === "win32" &&
      this.configuredBinary === undefined &&
      this.resolvedBinary === undefined
    )
      throw new GitError("git_missing", "Git for Windows was not found on PATH");
    // `--version` reads no repository: the fixed guards suffice, with no configuration query.
    const result = await this.executeRaw(cwd, ["--version"], {
      directoryFd,
      signal,
      env: nonExecutingEnv(),
    });
    const version = /^git version (\d+)\.(\d+)\.(\d+)/.exec(textOutput(result));
    const [major, minor] = version
      ? decode(z.tuple([z.string(), z.string(), z.string()]), version.slice(1), "version").map(
          count,
        )
      : [0, 0];
    if (
      !version ||
      major === undefined ||
      minor === undefined ||
      major < 2 ||
      (major === 2 && minor < 40)
    ) {
      throw new GitError("git_too_old", "ace requires Git 2.40 or newer", {
        binary: this.binary,
        version: result.stdout.toString().trim(),
      });
    }
  }

  private async execute(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    const policy = this.executionPolicy.getStore();
    const transport = typeof policy === "object" ? policy : undefined;
    const person = this.personScope();
    // Transfers are guarded unless a person asked for them; local calls follow the root's policy.
    const guarded = transport ? !person : this.executionDisabledAt(cwd);
    const hookless =
      !guarded &&
      person === "reviewer" &&
      args[0] !== "--version" &&
      (await this.hooksInsideCheckout(cwd, options.signal));
    if (!guarded && !hookless && !transport) return this.executeRaw(cwd, args, options);
    // Inspect effective driver/hook names only, never commands or credential values. Every nested
    // call is guarded here, including temporary-index writes, status and branch cleanup.
    const keys = guarded || hookless ? await this.executionKeys(cwd, options) : "";
    const settings =
      transport && ["push", "fetch", "ls-remote"].includes(args[0] ?? "")
        ? await this.transportSettings(cwd, options)
        : { helpers: [], sshCommand: undefined };
    const env = transport
      ? guarded
        ? nonExecutingTransportEnv(keys, transport.protocols, settings.sshCommand)
        : {
            ...(hookless ? hooklessEnv(keys) : {}),
            ...transportEnv(transport.protocols, settings.sshCommand),
          }
      : guarded
        ? nonExecutingEnv(keys)
        : hooklessEnv(keys);
    return this.executeRaw(
      cwd,
      [
        ...(guarded || transport ? ["-c", "protocol.allow=never"] : []),
        ...(transport ? credentialHelperArgs(settings.helpers) : []),
        ...args,
      ],
      { ...options, env: { ...options.env, ...env } },
    );
  }

  /**
   * A fact computed only from the configuration and repository discovery Git sees in `cwd`,
   * reused until any file Git reads them from changes (see `ConfigFacts`). `keep` decides whether
   * a computed value may be reused at all.
   */
  configFact<T>(
    cwd: string,
    name: string,
    compute: () => Promise<T>,
    keep?: (value: T) => boolean,
    env: Record<string, string> = {},
  ): Promise<T> {
    if (this.closed) return compute();
    return this.facts.read(cwd, this.configKeyEnv(env), name, compute, keep);
  }

  /** Call environment and the inherited variables that place the global config files. */
  private configKeyEnv(env: Record<string, string>): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const key of ["HOME", "XDG_CONFIG_HOME"] as const) {
      const value = process.env[key];
      if (value !== undefined) inherited[key] = value;
    }
    return configEnvironment({ ...inherited, ...env });
  }

  private async configSources(
    cwd: string,
    env: Record<string, string>,
  ): Promise<string[] | undefined> {
    await this.ensureReady(cwd);
    // Read-only config queries under the fixed guards, as the execution-key query itself runs.
    const query = (args: string[]) =>
      this.executeRaw(cwd, ["-c", "protocol.allow=never", ...args], {
        env: { ...env, ...nonExecutingEnv() },
        allowFailure: true,
        captureBytes: 4_194_304,
      });
    return learnConfigSources(cwd, query, () => this.standardConfigFiles(env, query), env.HOME);
  }

  /** Where this Git keeps its system and global files depends only on the environment. */
  private standardConfigFiles(
    env: Record<string, string>,
    query: Parameters<typeof standardConfigFiles>[0],
  ): Promise<string[] | undefined> {
    const key = JSON.stringify([this.binary, env]);
    const known = this.standardFiles.get(key);
    if (known) return known;
    const files = standardConfigFiles(query).catch(() => undefined);
    this.standardFiles.set(key, files);
    void files.then((found) => {
      if (!found) this.standardFiles.delete(key);
    });
    return files;
  }

  private executionKeys(cwd: string, options: CallOptions): Promise<string> {
    // A directory pinned by descriptor may sit behind a path that no longer leads to it.
    if (options.directoryFd !== undefined) return this.queryExecutionKeys(cwd, options);
    return this.configFact(
      cwd,
      "execution-keys",
      () => this.queryExecutionKeys(cwd, options),
      undefined,
      options.env,
    );
  }

  private async queryExecutionKeys(cwd: string, options: CallOptions): Promise<string> {
    const extensions = await this.executeRaw(
      cwd,
      ["-c", "protocol.allow=never", ...executionKeyQuery],
      {
        env: { ...options.env, ...nonExecutingEnv() },
        allowFailure: true,
        captureBytes: 1_048_576,
        signal: options.signal,
        directoryFd: options.directoryFd,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );
    if (extensions.truncated)
      throw new GitError("output_too_large", "Execution configuration is too large");
    if (extensions.exitCode !== 0 && extensions.exitCode !== 1)
      throw new GitError("git_failed", "Could not inspect execution configuration safely");
    if (!isUtf8(extensions.stdout))
      throw new GitError("malformed_output", "Invalid execution configuration encoding");
    return extensions.stdout.toString("utf8");
  }

  private async transportSettings(
    cwd: string,
    options: CallOptions,
  ): Promise<{ helpers: GitCredentialHelper[]; sshCommand: string | undefined }> {
    const query = (args: string[]) =>
      this.executeRaw(cwd, ["-c", "protocol.allow=never", ...args], {
        env: nonExecutingEnv(),
        allowFailure: true,
        captureBytes: 1_048_576,
        signal: options.signal,
        directoryFd: options.directoryFd,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    const lookup = this.credentialHelperLookup;
    const system = this.credentialConfigPaths.system ?? (await systemCredentialConfigFile(query));
    const settings = await userTransportConfig({
      files: [system, this.credentialConfigPaths.xdg, this.credentialConfigPaths.global],
      query,
      protectedRoots: [...this.protectedWorktrees],
      helpers: !lookup,
      // A checkout's own SSH command is the person's only where no agent or PR author writes.
      repositorySsh: !this.protectedPath(cwd),
      signal: options.signal,
    });
    if (!lookup) return settings;
    const helpers: GitCredentialHelper[] = [];
    for (const scope of ["system", "global"] as const) {
      options.signal?.throwIfAborted();
      helpers.push(...(await lookup(scope, options.signal)));
    }
    return { helpers, sshCommand: settings.sshCommand };
  }

  /**
   * Windows: Git runs in the held folder by its path while a lease keeps that folder in place
   * (see `directory-lease.ts`), and the path must still lead to it once Git has exited.
   */
  private async executeLeased(
    cwd: string,
    args: string[],
    options: CallOptions,
    fd: number,
  ): Promise<Output> {
    const { leaseHeldDirectory } = await import("./directory-lease.ts");
    const lease = leaseHeldDirectory(fd, { createGitEntry: options.write === true });
    let cleanup: Promise<unknown> | undefined;
    try {
      const output = await this.executeRaw(lease.cwd, args, { ...options, directoryFd: undefined });
      lease.verify();
      return output;
    } catch (error) {
      // A killed writer may outlive the call: the folder stays held until its cleanup settles.
      if (error instanceof GitError) cleanup = error.cleanup?.settled;
      lease.verify();
      throw error;
    } finally {
      if (cleanup) void cleanup.then(lease.release, lease.release);
      else lease.release();
    }
  }

  private executeRaw(cwd: string, args: string[], options: CallOptions): Promise<Output> {
    if (this.closed) return Promise.reject(new GitError("git_closed", "Git service closed"));
    const binary = this.binary;
    const env = inheritedEnv();
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      ...(options.write ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
      ...options.env,
    });
    if (this.runtime.platform === "win32") {
      if (options.directoryFd !== undefined)
        return this.executeLeased(cwd, args, options, options.directoryFd);
      args = windowsHooklessArgs(args);
      windowsHooklessEnv(env);
      // Deep checkout paths past MAX_PATH; Git for Windows refuses them by default.
      windowsLongPathsEnv(env);
    }
    if (typeof this.executionPolicy.getStore() === "object") {
      // Git can fall back from core.askPass to SSH_ASKPASS, even with terminal prompts off.
      delete env.SSH_ASKPASS;
      env.GIT_ASKPASS = "";
      env.GIT_TERMINAL_PROMPT = "0";
    }
    return new Promise((resolve, reject) => {
      const spawnOptions: Parameters<GitProcessRuntime["spawn"]>[2] = {
        cwd,
        env,
        shell: false,
        detached: this.runtime.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      };
      options.beforeSpawn?.();
      if (options.signal?.aborted)
        throw new GitError("git_cancelled", "Git operation cancelled before dispatch");
      const child =
        options.directoryFd === undefined
          ? this.runtime.spawn(binary, ["--no-pager", ...args], spawnOptions)
          : spawnPinned(
              this.runtime,
              binary,
              ["--no-pager", ...args],
              spawnOptions,
              options.directoryFd,
            );
      const pid = child.pid;
      if (pid) runningChildren.add(pid);
      child.once("exit", () => {
        if (pid) runningChildren.delete(pid);
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      const limit = options.captureBytes ?? 64 * 1024 * 1024;
      let captured = 0;
      let errorBytes = 0;
      const diagnostics = new GitDiagnostics();
      const tail = new StderrTail();
      let truncated = false;
      let failure: GitError | undefined;
      let spawnFailure: Promise<GitError> | undefined;
      const ownership = captureMutationOwnership();
      let stopped = false;
      let settled = false;
      const kill = () => {
        if (stopped) return;
        stopped = true;
        // From here this process is evidence that a writer may survive, not our running work.
        if (child.pid) runningChildren.delete(child.pid);
        const drain = drainProcessExit(child, this.runtime.scheduleTimeout);
        this.drains.add(drain);
        void drain.then(
          () => this.drains.delete(drain),
          () => this.drains.delete(drain),
        );
        const leases = ownership.leases;
        let cleanup: Promise<CleanupResult>;
        try {
          const supervised = this.runtime.cleanupSupervisor?.stop(child, leases);
          // Without a supervisor ace killed the whole process group itself, and the lease
          // retires as soon as that group is gone.
          const group =
            !supervised && this.runtime.platform !== "win32" && child.pid ? child.pid : undefined;
          const receipt = supervised ?? {
            settled: killTree(this.runtime, child).then(() => ({
              status: "unconfirmed" as const,
              reason: `No escaped-descendant containment on ${this.runtime.platform}`,
            })),
          };
          cleanup = ownership.quarantine(receipt, group);
          if (group !== undefined && leases.length) {
            const ids = leases.map(({ id }) => id);
            for (const id of ids) this.killed.add(id);
            void settleOwnLeases(ids, this.leaseProbe).then(
              () => ids.forEach((id) => this.killed.delete(id)),
              ignoreError,
            );
          }
        } catch {
          void killTree(this.runtime, child).catch(ignoreError);
          cleanup = ownership.quarantine({
            settled: Promise.resolve({
              status: "unconfirmed",
              reason: "Cleanup supervisor failed",
            }),
          });
        }
        if (failure) failure.cleanup = { settled: cleanup };
        // Releasing our descriptors bounds response/shutdown; ownership is held by
        // the durable quarantine, independently of these descriptors and close.
        detach();
        child.off("close", closed);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settled = true;
        reject(failure);
      };
      const cancel = () => {
        failure ??= new GitError("git_closed", "Git service closed");
        kill();
      };
      this.cancellations.add(cancel);
      const abort = () => {
        failure ??= new GitError("git_cancelled", "Git operation cancelled");
        kill();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const fail = (error: unknown) => {
        if (failure) return;
        failure = toGitError(error);
        kill();
      };
      const deadline = options.timeoutMs ?? this.timeoutMs;
      const cancelDeadline = this.runtime.scheduleTimeout(() => {
        fail(new GitError("git_timeout", `Git exceeded ${deadline}ms`, { args }));
      }, deadline);
      const streamFailure = (error: Error) => fail(error);
      child.stdout.on("error", streamFailure);
      child.stderr.on("error", streamFailure);
      if (options.output) {
        options.output.on("error", streamFailure);
        child.stdout.pipe(options.output);
      }
      const stdout = (chunk: Buffer) => {
        if (options.output) return;
        if (options.consume) {
          try {
            options.consume(chunk);
          } catch (error) {
            fail(error);
          }
          return;
        }
        const remaining = Math.max(0, limit - captured);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        captured += Math.min(remaining, chunk.length);
        if (chunk.length > remaining) {
          truncated = true;
          if (options.captureBytes === undefined) {
            fail(new GitError("output_too_large", "Git metadata exceeded 64 MiB", { args }));
          }
        }
      };
      const stderrData = (chunk: Buffer) => {
        try {
          options.stderr?.(chunk);
        } catch (error) {
          fail(error);
        }
        diagnostics.accept(chunk);
        tail.accept(chunk);
        const keep = Math.min(chunk.length, Math.max(0, 65_536 - errorBytes));
        if (keep) errors.push(Buffer.from(chunk.subarray(0, keep)));
        errorBytes += keep;
      };
      child.stdout.on("data", stdout);
      child.stderr.on("data", stderrData);
      const spawnError = (error: NodeJS.ErrnoException) => {
        // The developer tools Git was moved or removed: find what `git` runs now, next call.
        if (error.code === "ENOENT" && this.resolvedBinary === binary) {
          this.ready = undefined;
          this.resolvedBinary = undefined;
        }
        spawnFailure = classifySpawn(error, cwd, binary);
      };
      child.on("error", spawnError);
      const detach = () => {
        cancelDeadline();
        this.cancellations.delete(cancel);
        options.signal?.removeEventListener("abort", abort);
        if (options.input instanceof Readable) {
          options.input.unpipe(child.stdin);
          options.input.off("error", streamFailure);
        }
        if (options.output) {
          child.stdout.unpipe(options.output);
          options.output.off("error", streamFailure);
        }
        child.stdout.off("data", stdout);
        child.stderr.off("data", stderrData);
        child.stdout.off("error", streamFailure);
        child.stderr.off("error", streamFailure);
        child.off("error", spawnError);
        child.on("error", ignoreError);
        // Keep late pipe errors owned after detachment/destruction.
        child.stdout.on("error", ignoreError);
        child.stderr.on("error", ignoreError);
      };
      const closed = async (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        if (signal && !spawnFailure) {
          fail(
            new GitError("git_failed", "Git terminated by signal", { signal, stderr: tail.text() }),
          );
          return;
        }
        detach();
        settled = true;
        if (spawnFailure) failure ??= await spawnFailure;
        const stderr = Buffer.concat(errors).toString("utf8");
        if (failure) return reject(failure);
        if (code !== 0) {
          diagnostics.acceptOutput(outputTail(chunks));
          const category = diagnostics.finish();
          if (
            !options.allowFailure ||
            (this.executionDisabledAt(cwd) && category === "objects_not_available")
          )
            return reject(
              new GitError(category, failureMessage(category), {
                code,
                stderr: tail.text(),
                ...(diagnostics.lockFile ? { lock: diagnostics.lockFile } : {}),
              }),
            );
        }
        resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: code ?? -1, truncated });
      };
      child.once("close", closed);
      child.stdin.on("error", () => {});
      if (options.input instanceof Readable) {
        options.input.on("error", streamFailure);
        options.input.pipe(child.stdin);
      } else child.stdin.end(options.input);
      if (options.signal?.aborted) abort();
      if (this.closed) cancel();
    });
  }
}

function ignoreError() {}

/** The daemon's environment without Git's: repository/index selectors inherited from an agent
 * must not redirect our commands. */
function inheritedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

/** The last few KiB of captured stdout, for commands that report their failure there. */
function outputTail(chunks: readonly Buffer[]): string {
  const parts: Buffer[] = [];
  let bytes = 0;
  for (let index = chunks.length - 1; index >= 0 && bytes < 4096; index--) {
    const chunk = chunks[index];
    if (!chunk) continue;
    parts.unshift(chunk.subarray(Math.max(0, chunk.length - (4096 - bytes))));
    bytes += parts[0]?.length ?? 0;
  }
  return Buffer.concat(parts).toString("utf8");
}

async function classifySpawn(
  error: NodeJS.ErrnoException,
  cwd: string,
  binary: string,
): Promise<GitError> {
  if (error.code === "ENOENT") {
    try {
      await stat(cwd);
    } catch {
      return new GitError("not_a_repo", `Git working directory no longer exists: ${cwd}`);
    }
  }
  return new GitError(
    error.code === "ENOENT" ? "git_missing" : "git_failed",
    error.code === "ENOENT" ? `Git binary not found: ${binary}` : error.message,
    { binary },
  );
}

export function textOutput(output: Output): string {
  // Scalar plumbing output ends with one newline; paths are parsed only from -z formats.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output.stdout).replace(/\n$/, "");
  } catch {
    throw new GitError("malformed_output", "Malformed Git UTF-8 scalar");
  }
}

export function patchOutput(output: Output): string {
  const decoder = new StringDecoder("utf8");
  const text = decoder.write(output.stdout);
  return output.truncated ? text : text + decoder.end();
}
