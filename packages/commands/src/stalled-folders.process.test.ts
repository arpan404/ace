import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, openSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CommandCatalog, CommandFiles, SecureCommandIo, type Target } from "./index.ts";
import { CommandFilesystemUnavailable } from "./posix-lanes.ts";
import {
  commandCallOwner,
  directoryFlags,
  directoryReader,
  fileFlags,
  openCommandChild,
  openResolvedDirectory,
  useCommandCallDeadline,
} from "./posix.ts";

// Real worker threads blocked in real syscalls: a FIFO opened for reading with no writer blocks
// in openat the way a dead network mount or a cloud placeholder does.
const target: Target = { provider: "claude", instance: "personal", session: "t" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function folder(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ace-command-stall-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** A command root in its own parent: discovery pins a root through its parent folder. */
async function commandRoot(): Promise<string> {
  const path = join(await folder(), "commands");
  await mkdir(path);
  return path;
}
/** Makes a FIFO; the returned release lets a call blocked opening it return. */
function fifo(path: string): () => void {
  execFileSync("mkfifo", [path]);
  const release = () => {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // Nobody is blocked on it.
    }
  };
  cleanups.push(async () => release());
  return release;
}
function shortDeadline(ms: number): void {
  const restore = useCommandCallDeadline(ms);
  cleanups.push(async () => restore());
}
const openFds = () => readdirSync("/dev/fd").length;
/** When a call ended, and how. */
const settled = <T>(promise: Promise<T>): Promise<{ at: number; error?: unknown }> =>
  promise.then(
    () => ({ at: performance.now() }),
    (error: unknown) => ({ at: performance.now(), error }),
  );
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = performance.now() + ms;
  while (!check() && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
}
const stuckOpen = (
  directory: number,
  owner?: ReturnType<typeof commandCallOwner>,
): Promise<{ fd?: number; error?: unknown }> =>
  openCommandChild(directory, "stuck", constants.O_RDONLY, owner).then(
    (fd) => ({ fd }),
    (error: unknown) => ({ error }),
  );

it.skipIf(process.platform === "win32")(
  "a call stuck under one root doesn't delay another root, fails at its deadline, and the root works again",
  async () => {
    shortDeadline(400);
    const a = await folder();
    fifo(join(a, "stuck"));
    await writeFile(join(a, "prompt.md"), "A");
    const b = await folder();
    await writeFile(join(b, "prompt.md"), "B");
    const rootA = await openResolvedDirectory(openCommandChild, a);
    const rootB = await openResolvedDirectory(openCommandChild, b);
    cleanups.push(async () => {
      closeSync(rootA);
      closeSync(rootB);
    });
    const started = performance.now();
    const stuck = stuckOpen(rootA).then((r) => ({ ...r, after: performance.now() - started }));
    closeSync(await openCommandChild(rootB, "prompt.md", fileFlags));
    expect(performance.now() - started).toBeLessThan(300);
    const failed = await stuck;
    expect(failed.error).toBeInstanceOf(CommandFilesystemUnavailable);
    expect(failed.after).toBeGreaterThanOrEqual(390);
    expect(failed.after).toBeLessThan(2000);
    // The same root reads again on another thread while the stuck one drains.
    closeSync(await openCommandChild(rootA, "prompt.md", fileFlags));
  },
);

it.skipIf(process.platform === "win32")(
  "timed-out and cancelled calls leave no descriptor or directory stream open once they return",
  async () => {
    shortDeadline(250);
    const a = await folder();
    const release = fifo(join(a, "stuck"));
    await writeFile(join(a, "prompt.md"), "A");
    // Warm up: the first calls start threads and load the native library.
    const warm = await openResolvedDirectory(openCommandChild, a);
    closeSync(await openCommandChild(warm, "prompt.md", fileFlags));
    closeSync(warm);
    const baseline = openFds();
    for (let cycle = 0; cycle < 4; cycle++) {
      const root = await openResolvedDirectory(openCommandChild, a);
      // A directory stream open on the thread that will be abandoned.
      const reader = await directoryReader(await openCommandChild(root, ".", directoryFlags));
      await reader.read();
      const timedOut = await stuckOpen(root);
      expect(timedOut.error).toBeInstanceOf(CommandFilesystemUnavailable);
      await expect(reader.read()).rejects.toBeInstanceOf(CommandFilesystemUnavailable);
      await reader.close();
      // The blocked open now returns a descriptor nobody will receive; the draining thread
      // closes it, and the stream, before it exits.
      release();
      // A caller who gives up while its open runs: the late descriptor is closed for it.
      const owner = commandCallOwner();
      const cancelled = stuckOpen(root, owner);
      await new Promise((r) => setTimeout(r, 50));
      owner.cancel();
      expect((await cancelled).error).toBeInstanceOf(CommandFilesystemUnavailable);
      release();
      await owner.idle();
      closeSync(root);
      await until(() => openFds() <= baseline);
      expect(openFds()).toBeLessThanOrEqual(baseline);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "a process whose call is still blocked past its deadline exits when its work is done",
  async () => {
    const a = await folder();
    // Never released: the child's thread stays blocked in openat until the child exits.
    execFileSync("mkfifo", [join(a, "stuck")]);
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "stalled-call-exit.child.ts"), a],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 8000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(output.trim()).toBe("Command folder stopped responding");
    expect(exit).toBe(0);
  },
  15_000,
);

it.skipIf(process.platform === "win32")(
  "closing command files takes at most one deadline while their folders are stuck",
  async () => {
    shortDeadline(500);
    // Several stuck files under one root, and a second stuck root: without cancellation,
    // discovery would reach each stuck file in turn and spend a deadline on every one.
    const one = await commandRoot();
    for (const name of ["stuck-1.md", "stuck-2.md", "stuck-3.md"]) fifo(join(one, name));
    const two = await commandRoot();
    fifo(join(two, "stuck-1.md"));
    const roots = [one, two].map((path) => ({
      path,
      format: "claude" as const,
      scope: "user" as const,
      instance: "personal",
    }));
    // Discovery opens files without blocking; this opener drops O_NONBLOCK for the FIFOs, so
    // each read blocks in its root's worker the way a dead mount does.
    let blocked = 0;
    const io = new SecureCommandIo((directory, name, flags, owner) => {
      const stuck = name.startsWith("stuck-");
      if (stuck) blocked++;
      return openCommandChild(directory, name, stuck ? constants.O_RDONLY : flags, owner);
    });
    const stuck = new CommandFiles(new CommandCatalog(() => 0), roots, { io });
    const starting = stuck.start().catch(() => {});
    const healthy = await commandRoot();
    await writeFile(join(healthy, "unstuckreview.md"), "Review");
    const catalog = new CommandCatalog(() => 0);
    const other = new CommandFiles(catalog, [
      { path: healthy, format: "claude", scope: "user", instance: "personal" },
    ]);
    cleanups.push(() => other.close());
    const started = performance.now();
    await other.start();
    expect(performance.now() - started).toBeLessThan(300);
    expect(catalog.list(target, "unstuckreview").commands.map((c) => c.name)).toEqual([
      "unstuckreview",
    ]);
    await until(() => blocked > 0);
    const closing = performance.now();
    await stuck.close();
    await starting;
    expect(performance.now() - closing).toBeLessThan(750);
  },
);

it.skipIf(process.platform === "win32")(
  "cancelling one reader of a stuck folder fails its calls at once and leaves another reader's calls queued",
  async () => {
    shortDeadline(5000);
    const path = await commandRoot();
    const release = fifo(join(path, "stuck.md"));
    await writeFile(join(path, "ok.md"), "Fine");
    const root = { path, format: "claude" as const, scope: "user" as const };
    const closing = new SecureCommandIo((directory, name, flags, owner) =>
      openCommandChild(directory, name, name === "stuck.md" ? constants.O_RDONLY : flags, owner),
    );
    const staying = new SecureCommandIo();
    cleanups.push(() => staying.close());
    const stuck = settled(closing.read(root, join(path, "stuck.md")));
    // Let the stuck read reach the root's thread before queuing behind it.
    await new Promise((r) => setTimeout(r, 100));
    const queued = settled(closing.read(root, join(path, "ok.md")));
    const theirs = staying.read(root, join(path, "ok.md"));
    const cancelled = performance.now();
    const closed = closing.close();
    const [first, second] = await Promise.all([stuck, queued]);
    expect(first.error).toBeInstanceOf(CommandFilesystemUnavailable);
    expect(second.error).toBeInstanceOf(CommandFilesystemUnavailable);
    expect(Math.max(first.at, second.at) - cancelled).toBeLessThan(200);
    // The other reader's call waits behind the stuck call on the same root, and runs in order
    // once that call returns; the cancelled reader closes after its call has left the thread.
    release();
    await expect(theirs).resolves.toMatchObject({ text: "Fine" });
    await closed;
  },
);

it.skipIf(process.platform === "win32")(
  "a save refused while an earlier call is still stuck leaves no folder descriptor open",
  async () => {
    shortDeadline(250);
    const path = await commandRoot();
    fifo(join(path, "stuck.md"));
    const root = { path, format: "library" as const, scope: "user" as const };
    const io = new SecureCommandIo((directory, name, flags, owner) =>
      openCommandChild(directory, name, name === "stuck.md" ? constants.O_RDONLY : flags, owner),
    );
    cleanups.push(() => io.close());
    await expect(io.read(root, join(path, "stuck.md"))).rejects.toBeInstanceOf(
      CommandFilesystemUnavailable,
    );
    // The cleanup unlink is refused too, since the stuck call may still land; neither refusal
    // may skip closing the pinned folder. The first save warms up (a thread for the root).
    const save = (n: number) =>
      expect(
        io.writePrompt(root, join(path, "new.md"), "Text", null, `.prompt-${n}`),
      ).rejects.toThrow("hasn't finished");
    await save(0);
    const baseline = openFds();
    for (let n = 1; n <= 3; n++) await save(n);
    expect(openFds()).toBe(baseline);
  },
);
