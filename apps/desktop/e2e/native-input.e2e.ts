import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appEnvironment, desktop, electronBinary } from "../scripts/common.ts";

/**
 * The embedded browser's native input in real Electron: the app's own browser backend and view
 * host, driven by backend requests as the daemon sends them, with a page that records what
 * reaches it. People and agents share the page (ADR 0067, collaboration): nothing gates the
 * person's input. Opt in with ACE_E2E_ELECTRON=1 (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
let app: ElectronApplication;
let out: string;
let userData: string;

interface Observed {
  received: string[];
  value: string;
}
interface Harness {
  start(): Promise<void>;
  agentUse(active: boolean): Promise<void>;
  localInput(x: number, y: number, key: string): void;
  relayedDuringLocal(local: { x: number; y: number; key: string }): Promise<void>;
  relayedClick(x: number, y: number): Promise<void>;
  observed(): Promise<Observed>;
  reset(): Promise<void>;
}

describe.skipIf(!enabled)("embedded view native input", () => {
  beforeAll(async () => {
    // Each run builds into its own folder, so concurrent runs never share artefacts.
    out = await mkdtemp(join(tmpdir(), "ace-e2e-input-build-"));
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
    if (out) await rm(out, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await app.evaluate(async () => (Reflect.get(globalThis, "harness") as Harness).reset());
  });

  it.each([true, false])(
    "while an agent uses the page (%s), its relayed input and the person's own input both arrive",
    async (agent) => {
      const result = await app.evaluate(async (_electron, active) => {
        const h = Reflect.get(globalThis, "harness") as Harness;
        await h.agentUse(active);
        await h.relayedDuringLocal({ x: 300, y: 300, key: "z" });
        return h.observed();
      }, agent);
      expect(result.received).toEqual(
        expect.arrayContaining([
          "down 20,20",
          "up 20,20",
          "keydown a",
          "keyup a",
          "down 300,300",
          "keydown z",
        ]),
      );
    },
  );
});
