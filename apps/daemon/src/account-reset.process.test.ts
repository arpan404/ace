import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { AccountManagement } from "./account-management.ts";

const now = () => 1_800_000_000_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-reset-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const executable = join(root, "codex");
  // Synthetic provider boundary: persist a balance per CLI home, including consumed attempt
  // identities. The real app-server transport runs in a real child process.
  await writeFile(
    executable,
    `#!${process.execPath}
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.env.OPENAI_API_KEY) process.exit(4);
const path = join(process.env.CODEX_HOME, "balance.json");
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  let result = {};
  if (msg.method !== "initialize") {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (msg.method === "account/rateLimitResetCredit/consume") {
      if (state.attempts.includes(msg.params.idempotencyKey)) result = { outcome: "alreadyRedeemed" };
      else {
        state.attempts.push(msg.params.idempotencyKey);
        state.available--;
        state.used = 0;
        await writeFile(path, JSON.stringify(state));
        result = { outcome: "reset", futureField: true };
      }
    } else if (msg.method === "account/rateLimits/read") result = {
      rateLimitResetCredits: { availableCount: state.available },
      rateLimits: { limitId: "codex", primary: { usedPercent: state.used, windowDurationMins: 300, resetsAt: 1900000000 } }
    };
  }
  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
}
`,
    { mode: 0o700 },
  );
  for (const id of ["personal", "team"]) {
    const homeDir = join(root, id);
    await mkdir(homeDir);
    await writeFile(
      join(homeDir, "balance.json"),
      JSON.stringify({ available: 2, used: 100, attempts: [] }),
    );
    await registry.register(createInstance({ id, provider: "codex", label: id, homeDir }));
  }
  const env = { PATH: process.env.PATH, OPENAI_API_KEY: "ambient-key-must-not-be-used" };
  const management = new AccountManagement({
    registry,
    accounts: new AccountService({ registry, env, now, timeZone: "UTC" }),
    env,
    dataDir: root,
    now,
    id: randomUUID,
    models: () => undefined,
    discovery: { overrides: { codex: executable } },
  });
  cleanups.push(async () => {
    await management.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return { management, registry, root };
}

test("redeeming resets only the chosen account and retrying the same attempt spends no second credit", async () => {
  const { management, registry, root } = await fixture();
  await management.refreshLimits();
  const key = randomUUID();
  expect(await management.consumeReset("personal", key)).toBe("reset");
  expect(registry.get("personal")?.quota.resetCredits?.available).toBe(1);
  expect(
    Object.values(registry.get("personal")?.quota.windows ?? {}).map(
      (window) => window.usedPercent,
    ),
  ).toEqual([0]);
  expect(registry.get("team")?.quota.resetCredits?.available).toBe(2);
  expect(await management.consumeReset("personal", key)).toBe("alreadyRedeemed");
  expect(JSON.parse(await readFile(join(root, "personal", "balance.json"), "utf8")).available).toBe(
    1,
  );
});

test("a disabled account cannot spend its banked resets", async () => {
  const { registry, root } = await fixture();
  const { consumeAccountReset } = await import("./account-reset.ts");
  await expect(
    consumeAccountReset({
      registry,
      instanceId: "personal",
      idempotencyKey: randomUUID(),
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      configuration: { enabled: false },
    }),
  ).rejects.toThrow("unavailable");
  expect(JSON.parse(await readFile(join(root, "personal", "balance.json"), "utf8")).available).toBe(
    2,
  );
});
