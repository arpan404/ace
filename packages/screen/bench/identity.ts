// Only the disposable IdentityFixture is operated. Latencies are reports, never gates.
import { once } from "node:events";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSupervised } from "@ace/provider-kit/process";
import { Helper } from "../src/index.ts";
import { ScreenInventory } from "@ace/protocol";
const root = new URL("../../../native/screen-helper/", import.meta.url).pathname;
let serial = 0;
const helper = await Helper.open({
  command: process.env.IDENTITY_HELPER ?? join(root, "build/ace-screen-helper"),
  args: ["--inherit-responsibility"],
  nextId: () => `id-${serial++}`,
  onFrame: () => {},
  onFailure: () => {},
});
const app = spawnSupervised({
  command: join(root, "build/IdentityFixture.app/Contents/MacOS/IdentityFixture"),
  args: ["--onscreen", "-ApplePersistenceIgnoreState", "YES"],
  env: {},
  name: "identity-fixture",
});
try {
  await once(app.stdout, "line");
  const events: string[] = [];
  app.stdout.on("line", (line: string) => events.push(line));
  const capabilities = await helper.negotiate();
  console.log(JSON.stringify({ permissions: capabilities?.permissions }));
  const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
  const windows = inventory.windows
    .filter((w) => w.bundleId === "dev.ace.identity-fixture")
    .toSorted((a, b) => a.title.localeCompare(b.title));
  for (const window of windows) {
    const scope = {
      target: { kind: "window", bundleId: window.bundleId, windowId: window.windowId } as const,
      allowlist: [window.bundleId],
    };
    try {
      await helper.request({
        op: "start",
        ...scope,
        sessionId: "fixture",
        fps: 10,
        capture: false,
      });
    } catch (e) {
      console.log(JSON.stringify({ start: String(e) }));
      break;
    }
    for (const op of ["key.press", "text.type", "ui.tree"] as const) {
      const samples: number[] = [];
      const errors: string[] = [];
      for (let i = 0; i < 8; i++) {
        const at = performance.now();
        try {
          await helper.request(
            op === "ui.tree"
              ? { op, ...scope, maxNodes: 32, maxDepth: 5 }
              : {
                  op: "input",
                  sessionId: "fixture",
                  input:
                    op === "text.type"
                      ? { kind: op, text: "abc" }
                      : { kind: op, key: "l", modifiers: [] },
                },
          );
        } catch (e) {
          errors.push(String(e));
        }
        samples.push(performance.now() - at);
      }
      console.log(
        JSON.stringify({
          window: window.title,
          op,
          medianMs: samples.toSorted((a, b) => a - b)[4],
          errors,
        }),
      );
    }
    app.stdin.write("snapshot\n");
    await once(app.stdout, "line");
    console.log(JSON.stringify({ fixtureEvents: events.splice(0) }));
    await helper.request({ op: "stop", sessionId: "fixture" });
  }
} finally {
  await helper.close();
  await app.stop({ graceMs: 0 });
}
