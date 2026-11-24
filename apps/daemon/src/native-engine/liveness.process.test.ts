// SPDX-License-Identifier: Apache-2.0
/**
 * The pump's keepalive across real process exits (E5.1 step 6). A real process exit is the only
 * edge that can see it, so each case is a child Bun process with the switch on:
 *
 * - a closed native engine lets its process exit;
 * - a pending engine promise keeps the process alive until it settles, then lets it exit (the
 *   port's timer is unref'd, so only the engine's holder count can be what keeps it up);
 * - an idle native engine never keeps its process alive (it is built and never closed).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { engineBackend } from "@ace/provider-kit/native-switches";

const native = engineBackend() === "native";
const root = fileURLToPath(new URL("../../../../", import.meta.url));

function childScript(): string {
  const file = join(mkdtempSync(join(tmpdir(), "ace-liveness-child-")), "child.ts");
  writeFileSync(
    file,
    `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from ${JSON.stringify(join(root, "apps/daemon/src/store.ts"))};
import { Engine } from ${JSON.stringify(join(root, "apps/daemon/src/engine/index.ts"))};

const home = mkdtempSync(join(tmpdir(), "ace-liveness-home-"));
const store = new Store(join(home, "events.sqlite"));
const mode = process.env.ACE_LIVENESS_CASE;
if (mode === "pending") {
  let resolvePort;
  const port = new Promise((resolve) => (resolvePort = resolve));
  const engine = new Engine(store, { waitForProvider: () => port });
  engine.ready().catch(() => {});
  const call = engine.ensureProvider("codex");
  const timer = setTimeout(() => resolvePort(), 300);
  timer.unref();
  await call;
  await engine.close();
  await store.close();
} else if (mode === "closed") {
  const engine = new Engine(store, {});
  engine.ready().catch(() => {});
  await engine.close();
  await store.close();
} else {
  // Idle: built, never closed, nothing pending once readiness settles.
  const engine = new Engine(store, {});
  engine.ready().catch(() => {});
}
`,
  );
  return file;
}

function runCase(mode: string): { elapsed: number; status: number | null; output: string } {
  const began = Date.now();
  const child = spawnSync(process.execPath, [childScript()], {
    env: {
      ...process.env,
      ACE_LIVENESS_CASE: mode,
      ACE_STORE: "native",
      ACE_STORE_WRITER: "fold,sequences,events,columns,live,transactions",
      ACE_ENGINE: "native",
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    elapsed: Date.now() - began,
    status: child.status,
    output: `${child.stdout}${child.stderr}`,
  };
}

describe.runIf(native)("the native engine's process liveness", () => {
  test("a closed native engine lets its process exit", () => {
    const result = runCase("closed");
    expect(result.output).not.toContain("NativeEngineIncomplete");
    expect(result.status).toBe(0);
    expect(result.elapsed).toBeLessThan(5_000);
  });

  test("a pending engine promise keeps its process alive until it settles, then lets it exit", () => {
    const result = runCase("pending");
    expect(result.status).toBe(0);
    expect(result.elapsed).toBeGreaterThanOrEqual(300);
    expect(result.elapsed).toBeLessThan(5_000);
  });

  test("an idle native engine never keeps its process alive", () => {
    const result = runCase("idle");
    expect(result.status).toBe(0);
    expect(result.elapsed).toBeLessThan(5_000);
  });
});
