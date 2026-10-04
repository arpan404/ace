import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appEnvironment, desktop, electronBinary } from "../scripts/common.ts";

/**
 * The embedded browser's native input gate in real Electron: the app's own view host with a
 * page that records what reaches it. Opt in with ACE_E2E_ELECTRON=1 (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
const out = join(desktop, "dist/e2e-native-input");
let app: ElectronApplication;
let userData: string;

interface Harness {
  start(): Promise<void>;
  setNativeInput(enabled: boolean): void;
  localInput(x: number, y: number, key: string): void;
  relayedDuringLocal(local: { x: number; y: number; key: string }): Promise<void>;
  relayedClick(x: number, y: number): Promise<void>;
  received(): Promise<string[]>;
  reset(): Promise<void>;
}

describe.skipIf(!enabled)("embedded view native input", () => {
  beforeAll(async () => {
    await build({
      entryPoints: [join(desktop, "e2e/fixtures/native-input-main.ts")],
      outfile: join(out, "main.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["electron"],
      logLevel: "warning",
      banner: {
        js: 'import { createRequire as __aceCreateRequire } from "node:module"; const require = __aceCreateRequire(import.meta.url);',
      },
    });
    userData = await mkdtemp(join(tmpdir(), "ace-e2e-input-"));
    app = await electron.launch({
      executablePath: await electronBinary(),
      args: [join(out, "main.mjs")],
      env: { ...appEnvironment(process.env), ACE_E2E_USER_DATA: userData },
    });
    await app.evaluate(async () => {
      await (Reflect.get(globalThis, "harness") as Harness).start();
    });
  });

  afterAll(async () => {
    await app?.close();
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await app.evaluate(async () => (Reflect.get(globalThis, "harness") as Harness).reset());
  });

  it("lets relayed input in while the person's simultaneous unauthorized input stays out", async () => {
    const received = await app.evaluate(async () => {
      const h = Reflect.get(globalThis, "harness") as Harness;
      h.setNativeInput(false);
      await h.relayedDuringLocal({ x: 300, y: 300, key: "z" });
      return h.received();
    });
    expect(received).toContain("click 40,40");
    expect(received).toContain("key a");
    expect(received).not.toContain("click 300,300");
    expect(received).not.toContain("key z");
  });

  it("lets the person in while the lease is theirs, and shuts them out the moment it goes", async () => {
    const received = await app.evaluate(async () => {
      const h = Reflect.get(globalThis, "harness") as Harness;
      h.setNativeInput(true);
      h.localInput(100, 120, "q");
      // Handback: the very next local input is refused, relayed input still arrives.
      h.setNativeInput(false);
      h.localInput(200, 220, "w");
      await h.relayedClick(60, 70);
      return h.received();
    });
    expect(received).toEqual(expect.arrayContaining(["click 100,120", "key q", "click 60,70"]));
    expect(received).not.toContain("click 200,220");
    expect(received).not.toContain("key w");
  });
});
