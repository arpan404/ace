import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "@ace/diagnostics";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import { Resources } from "./resources.ts";
import { startProviderInstalls } from "./provider-install.ts";
import type { ServiceContext } from "./types.ts";

test("shutdown aborts a slow install planning probe before draining socket tasks", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-install-shutdown-"));
  const entered = join(home, "entered");
  await writeFile(
    join(home, "npm"),
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(entered)},'ready');setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  const store = new Store(":memory:");
  const resources = new Resources();
  const log = createLogger({
    now: () => 1,
    redact: (s) => s,
    sink: { async write() {}, async close() {} },
  });
  const context: ServiceContext = {
    signal: new AbortController().signal,
    config: readConfig({ ACE_HOME: home }),
    options: { providerStatus: { env: { HOME: home, PATH: home } } },
    store,
    now: () => 1,
    id: () => "id",
    log,
    resources,
    services: {},
    onListen: [],
  };
  try {
    startProviderInstalls(context);
    const installs = context.services.providerInstalls;
    if (!installs) throw new Error("Missing installs");
    const planning = installs
      .plan({ provider: "codex" }, "install")
      .catch((error: unknown) => error);
    await expect.poll(() => readFile(entered, "utf8")).toBe("ready");
    resources.beginShutdown();
    await expect(planning).resolves.toBeDefined();
    expect(
      await installs.handle("device", {
        type: "provider.install.plan",
        requestId: "later",
        provider: "codex",
        action: "install",
      }),
    ).toMatchObject({ result: { ok: false, error: "unavailable" } });
  } finally {
    await resources.close();
    await store.close();
    await log.close();
    await rm(home, { recursive: true, force: true });
  }
});
