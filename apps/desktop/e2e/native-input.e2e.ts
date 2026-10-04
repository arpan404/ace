import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appEnvironment, desktop, electronBinary } from "../scripts/common.ts";

/**
 * The embedded browser's native input gate in real Electron: the app's own browser backend and
 * view host, driven by backend requests as the daemon sends them, with a page that records what
 * reaches it. Opt in with ACE_E2E_ELECTRON=1 (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
let app: ElectronApplication;
let out: string;
let userData: string;
/** Lease generations only grow, across tests too. */
let generation = 0;

interface Observed {
  received: string[];
  value: string;
}
interface Harness {
  start(): Promise<void>;
  lease(generation: number, controller: "agent" | "human", owner?: string): Promise<void>;
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

  it.each([
    ["another device holds the lease", "human", "phone-connection"],
    ["the agent holds the lease", "agent", undefined],
  ] as const)(
    "while %s, relayed input arrives and the person's simultaneous local input does not",
    async (_label, controller, owner) => {
      const result = await app.evaluate(
        async (_electron, args) => {
          const h = Reflect.get(globalThis, "harness") as Harness;
          await h.lease(args.generation, args.controller, args.owner);
          await h.relayedDuringLocal({ x: 300, y: 300, key: "z" });
          return h.observed();
        },
        { generation: ++generation, controller, owner },
      );
      // The relayed click and key press, released and typed.
      expect(result.received).toEqual(
        expect.arrayContaining(["down 20,20", "up 20,20", "keydown a", "keyup a"]),
      );
      expect(result.value).toBe("a");
      // None of the person's own click, key or text.
      expect(result.received.filter((entry) => /300,300|\bz$/.test(entry))).toEqual([]);
    },
  );

  it("under this app's own lease the person's input arrives, and a handback refuses the very next local event", async () => {
    const result = await app.evaluate(
      async (_electron, first) => {
        const h = Reflect.get(globalThis, "harness") as Harness;
        await h.lease(first, "human", "desktop-connection");
        h.localInput(20, 20, "q");
        // Handback: the agent's lease arrives, then the person clicks and types again.
        await h.lease(first + 1, "agent");
        h.localInput(200, 220, "w");
        await h.relayedClick(60, 70);
        return h.observed();
      },
      ((generation += 2), generation - 1),
    );
    expect(result.received).toEqual(
      expect.arrayContaining(["down 20,20", "up 20,20", "keydown q", "keyup q", "down 60,70"]),
    );
    expect(result.value).toBe("q");
    expect(result.received.filter((entry) => /200,220|\bw$/.test(entry))).toEqual([]);
  });
});
