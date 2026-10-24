import { join } from "node:path";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { ComputerClient } from "./client.ts";
import { ComputerActResult, ComputerHello, ComputerState } from "./wire.ts";
import { ids } from "../testing/support.ts";

const root = new URL("../../../../native/screen-helper/", import.meta.url).pathname;
const integration = process.platform === "darwin" && process.env.ACE_SCREEN_INTEGRATION === "1";
const fixtureReply = z.object({
  ready: z.array(z.number()).optional(),
  active: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  clicks: z.array(z.number()).optional(),
});

it.skipIf(!integration)(
  "background clicks and typing reach only the selected off-display window without activating the app",
  async (context) => {
    // Build the signed helper explicitly before this opt-in test. Test HOME is isolated
    // and cannot access the person's signing keychain.
    const build = await probeOutput("sh", [join(root, "Tests/Fixture/build.sh")], {
      timeoutMs: 120_000,
    });
    expect(build.code, build.stderr).toBe(0);
    const helper = join(root, "build/ace-screen-helper");
    const client = new ComputerClient({
      helper: async () => helper,
      nextId: ids(),
    });
    onTestFinished(() => client.close());
    if (!ComputerHello.parse(await client.request("hello", {})).accessibility) {
      context.skip("Requires an existing Accessibility grant");
      return;
    }
    const app = spawnSupervised({
      command: join(root, "build/IdentityFixture.app/Contents/MacOS/IdentityFixture"),
      args: ["-ApplePersistenceIgnoreState", "YES"],
      env: {},
      name: "computer-background-fixture",
    });
    onTestFinished(async () => {
      await app.stop({ graceMs: 0 });
    });
    const replies: z.infer<typeof fixtureReply>[] = [];
    const waiting = new Set<() => void>();
    app.stdout.on("line", (line: string) => {
      replies.push(fixtureReply.parse(JSON.parse(line)));
      for (const notify of waiting) notify();
    });
    function reply(predicate: (value: z.infer<typeof fixtureReply>) => boolean) {
      return new Promise<z.infer<typeof fixtureReply>>((resolve) => {
        const notify = () => {
          const index = replies.findIndex(predicate);
          if (index < 0) return;
          const value = replies.splice(index, 1)[0];
          if (value) {
            waiting.delete(notify);
            resolve(value);
          }
        };
        waiting.add(notify);
        notify();
      });
    }
    await reply((value) => value.ready !== undefined);
    const target = { app: "dev.ace.identity-fixture", window: "Identity 1" };
    const state = ComputerState.parse(await client.request("state", target));
    expect(state.app.active).toBe(false);
    const button = state.nodes.find((node) => node.name === "Increment 1");
    const field = state.nodes.find((node) => node.name === "Destination 1");
    if (!button || !field) throw new Error("Fixture controls missing from the outline");
    const result = ComputerActResult.parse(
      await client.request("act", {
        ...target,
        actions: [
          // A held click forces posted mouse events instead of AXPress.
          { type: "click", id: button.id, hold_ms: 1 },
          { type: "type", id: field.id, text: "background input" },
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.state?.app.active).toBe(false);
    app.stdin.write("snapshot\n");
    const snapshot = await reply((value) => value.values !== undefined);
    expect(snapshot.clicks).toEqual([0, 1]);
    expect(snapshot.values).toEqual(["", "background input"]);
    expect(snapshot.active).toBe(false);
  },
  360_000,
);
