import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CommandCatalog, CommandFiles, SecureCommandIo, type CommandFileIo } from "./index.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function home() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ace-command-lifecycle-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
it("repeated concurrent startup disposes every watcher and recovery timer", async () => {
  const path = await home(),
    root = join(path, "prompts");
  await mkdir(root);
  await writeFile(join(root, "item.md"), "Body");
  const watchers = new Set<object>(),
    timers = new Set<object>();
  const files = new CommandFiles(
    new CommandCatalog(() => 0),
    [{ path: root, scope: "user", format: "library" }],
    {
      watch() {
        const lease = {};
        watchers.add(lease);
        return () => {
          watchers.delete(lease);
        };
      },
      schedule() {
        const lease = {};
        timers.add(lease);
        return () => {
          timers.delete(lease);
        };
      },
    },
  );
  cleanups.push(() => files.close());
  await Promise.all([files.start(), files.start()]);
  await files.close();
  expect(watchers.size).toBe(0);
  expect(timers.size).toBe(0);
  await files.start();
  expect(watchers.size).toBe(0);
  expect(timers.size).toBe(0);
});
it("closing during watcher acquisition cannot leave a lease or recovery timer alive", async () => {
  const path = await home(),
    root = join(path, "prompts");
  await mkdir(root);
  const leases = new Set<object>();
  let closing: Promise<void> | undefined;
  const files = new CommandFiles(
    new CommandCatalog(() => 0),
    [{ path: root, scope: "user", format: "library" }],
    {
      watch() {
        const lease = {};
        leases.add(lease);
        closing ??= files.close();
        return () => {
          leases.delete(lease);
        };
      },
      schedule() {
        const lease = {};
        leases.add(lease);
        return () => {
          leases.delete(lease);
        };
      },
    },
  );
  cleanups.push(() => files.close());
  await files.start();
  await closing;
  expect(leases.size).toBe(0);
});
it("shutdown drains suspended directory I/O and releases its newly acquired cursor", async () => {
  const path = await home(),
    root = join(path, "prompts"),
    nested = join(root, "nested");
  await mkdir(root);
  const real = new SecureCommandIo(),
    entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  const cursors = new Set<object>(),
    watchers = new Set<object>();
  const io: CommandFileIo = {
    stat: (r, p) => real.stat(r, p),
    read: (r, p) => real.read(r, p),
    close: () => real.close(),
    async directory(r, p) {
      if (p === nested) {
        entered.resolve();
        await released.promise;
      }
      const reader = await real.directory(r, p),
        lease = {};
      cursors.add(lease);
      return {
        read: () => reader.read(),
        async close() {
          await reader.close();
          cursors.delete(lease);
        },
      };
    },
  };
  const files = new CommandFiles(
    new CommandCatalog(() => 0),
    [{ path: root, scope: "user", format: "library" }],
    {
      io,
      watch() {
        const lease = {};
        watchers.add(lease);
        return () => {
          watchers.delete(lease);
        };
      },
      schedule: () => () => {},
    },
  );
  cleanups.push(() => files.close());
  try {
    await files.start();
    await mkdir(nested);
    files.invalidate(root);
    const updating = files.flush();
    await entered.promise;
    const closing = files.close();
    released.resolve();
    await Promise.all([updating, closing]);
    expect(cursors.size).toBe(0);
    expect(watchers.size).toBe(0);
  } finally {
    released.resolve();
  }
});

it("duplicate directory invalidations preserve a suspended scan until every new snippet is discovered", async () => {
  const path = await home(),
    root = join(path, "prompts");
  await mkdir(root);
  const real = new SecureCommandIo();
  const entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  let suspend = false;
  const io: CommandFileIo = {
    stat: (r, p) => real.stat(r, p),
    read: (r, p) => real.read(r, p),
    close: () => real.close(),
    async directory(r, p) {
      const reader = await real.directory(r, p);
      return {
        async read() {
          if (suspend) {
            suspend = false;
            entered.resolve();
            await released.promise;
          }
          return reader.read();
        },
        close: () => reader.close(),
      };
    },
  };
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(catalog, [{ path: root, scope: "user", format: "library" }], {
    io,
    watch: () => () => {},
    schedule: () => () => {},
  });
  cleanups.push(() => files.close());
  try {
    await files.start();
    for (let i = 0; i < 80; i++) await writeFile(join(root, `new${i}.md`), `Body ${i}`);
    suspend = true;
    files.invalidate(root);
    const updating = files.flush();
    await entered.promise;
    files.invalidate(root);
    released.resolve();
    await updating;
    const target = { provider: "claude", instance: "personal", session: "test" } as const;
    const commands = catalog.list(target, "new", 100).commands;
    expect(commands).toHaveLength(80);
    for (let i = 0; i < 80; i++) {
      const command = commands.find((c) => c.name === `new${i}`);
      if (!command) throw new Error("Missing newly discovered snippet");
      expect(catalog.resolve(target, command.id)).toEqual({
        ok: true,
        plan: { kind: "prompt", provider: "claude", text: `Body ${i}` },
      });
    }
  } finally {
    released.resolve();
  }
});

it("unnamed nested directory notifications discover new snippets in that directory", async () => {
  const path = await home(),
    root = join(path, "prompts"),
    nested = join(root, "nested");
  await mkdir(nested, { recursive: true });
  const notifications = new Map<string, (file: string | undefined) => void>();
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(catalog, [{ path: root, scope: "user", format: "library" }], {
    watch(p, changed) {
      notifications.set(p, changed);
      return () => {
        notifications.delete(p);
      };
    },
    schedule: () => () => {},
  });
  cleanups.push(() => files.close());
  await files.start();
  await writeFile(join(nested, "added.md"), "New nested body");
  const notify = notifications.get(nested);
  if (!notify) throw new Error("Missing nested directory watcher");
  notify(undefined);
  await files.flush();
  const target = { provider: "claude", instance: "personal", session: "test" } as const;
  const command = catalog.list(target, "nested:added").commands[0];
  if (!command) throw new Error("Missing nested snippet");
  expect(catalog.resolve(target, command.id)).toEqual({
    ok: true,
    plan: { kind: "prompt", provider: "claude", text: "New nested body" },
  });
});
