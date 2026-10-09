import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { createInstance, initialQuota } from "@ace/accounts";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { createRedactor } from "@ace/redaction";
import { Store } from "./store.ts";
import { readConfig } from "./config.ts";
import { startAccounts } from "./services/accounts.ts";
import { startHistory } from "./services/history.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";

test("account migrations and failed past-session scans keep redacted log fields instead of omitted objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-real-shapes-"));
  const home = join(root, "ace");
  const source = join(root, ".ace/instances/cursor-sdk-default");
  const shared = join(root, ".agents/skills/check-state");
  const openCode = join(root, "opencode");
  await mkdir(source, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(
    join(shared, "SKILL.md"),
    "---\nname: check-state\ndescription: Check saved work\n---\nCheck the visible result.\n",
  );
  await symlink(join(root, ".agents/skills"), join(source, "skills"), "dir");
  // Old OpenCode messages can contain tool definitions much larger than the scanner's head.
  await mkdir(join(openCode, "storage/message/legacy"), { recursive: true });
  await writeFile(
    join(openCode, "storage/message/legacy/message.json"),
    JSON.stringify({
      id: "legacy",
      sessionID: "saved",
      role: "assistant",
      modelID: "muse-spark-1.3-contributor",
      providerID: "opencode-go",
      time: { created: 1 },
      tools: { schema: "definition ".repeat(17000) },
    }),
  );
  await mkdir(home);
  const accountsPath = join(home, "accounts.sqlite");
  vi.stubEnv("ACE_ACCOUNTS_DB", accountsPath);
  const db = new DatabaseSync(accountsPath);
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,instance TEXT NOT NULL,quota TEXT NOT NULL)");
  const instance = createInstance({
    id: "cursor-sdk-default",
    label: "Synthetic",
    provider: "cursor",
    homeDir: source,
  });
  db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(
    instance.id,
    JSON.stringify(instance),
    JSON.stringify(initialQuota()),
  );
  db.close();
  const redaction = { env: { CUSTOM_API_KEY: "synthetic-private-value" } };
  const log = createLogger({
    sink: await createFileSink({
      directory: join(home, "logs"),
      fileBytes: 65536,
      totalBytes: 131072,
      context: redaction,
    }),
    now: () => 1,
    redact: createRedactor(redaction),
    level: "info",
  });
  const store = new Store(join(home, "events.sqlite"));
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: home }),
    options: {
      history: {
        spawnWorker: () =>
          new Worker(
            `const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ id: 0, value: true }); parentPort.on('message', (message) => { if (message && typeof message === 'object' && 'id' in message) parentPort.postMessage(message.request.op === 'close' ? { id: message.id, value: null } : { id: message.id, error: 'Synthetic saved-history worker failure' }); });`,
            { eval: true },
          ),
        instances: [{ id: "opencode", provider: "opencode", homeDir: openCode }],
      },
    },
    store,
    resources: new Resources(),
    services: {},
    log,
    now: () => 1,
    id: () => "id",
    signal: new AbortController().signal,
    onListen: [],
  };
  try {
    await startAccounts(context);
    const migrated = context.services.accountRegistry?.get(instance.id)?.instance;
    if (!migrated) throw new Error("Missing migrated account");
    expect(await readFile(join(migrated.homeDir, "skills/check-state/SKILL.md"), "utf8")).toContain(
      "Check the visible result.",
    );
    await startHistory(context);
    const history = context.services.history;
    if (!history) throw new Error("Missing history service");
    await history.startScan();
    expect(history.scanStatus().state).toBe("failed");
    await expect(
      history.handle({ type: "history.list", cwd: root, limit: 10 }, context.signal),
    ).rejects.toThrow();
    await context.resources.close();
    await log.flush();
    const text = await readFile(join(home, "logs/ace.jsonl"), "utf8");
    expect(text).toContain('"message":"Account instance home migrated"');
    expect(text).toContain('"instance":"cursor-sdk-default"');
    expect(text).toContain('"operation":"history.scan"');
    expect(text).toContain('"operation":"history.list"');
    expect(text).not.toContain("UNPREPARED OBJECT OMITTED");
    expect(text).not.toContain("synthetic-private-value");
  } finally {
    await context.resources.close();
    await store.close();
    await log.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
