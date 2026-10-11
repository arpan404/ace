import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeOutput } from "@ace/provider-kit/process";
import { manager, target } from "./testing/support.ts";
import { allowForeground } from "./testing/foreground.ts";
// Build with cargo build --manifest-path native/screen-helper-linux/Cargo.toml --example wire_fixture.
const fixture = new URL(
  "../../../native/screen-helper-linux/target/debug/examples/wire_fixture",
  import.meta.url,
).pathname;
it.skipIf(!existsSync(fixture))(
  "native Linux encodings pass public tree and search validation and their refs are admitted for actions",
  async () => {
    const output = await probeOutput(fixture, [], { timeoutMs: 30_000 });
    expect(output.code, output.stderr).toBe(0);
    const directory = await mkdtemp(join(tmpdir(), "ace-linux-wire-"));
    try {
      const path = join(directory, "native.json");
      await writeFile(path, output.stdout);
      const h = await manager(
        { NATIVE_UI_REPLIES: path },
        {
          args: [new URL("./testing/fake-helper-linux.ts", import.meta.url).pathname],
          protocolVersion: 2,
        },
      );
      try {
        await h.screen.enable(true);
        await h.screen.approve(target.bundleId, true);
        const session = await h.screen.start(target);
        const tree = await h.screen.uiTree(session.sessionId, {});
        const root = tree.nodes[0];
        if (!root) throw new Error("Missing native node");
        expect(root.ref).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
        expect([...root.name]).toHaveLength(256);
        expect([...(root.description ?? "")]).toHaveLength(256);
        expect([...(root.value ?? "")]).toHaveLength(512);
        expect(tree.truncated).toBe(true);
        expect(
          (await h.screen.uiFind(session.sessionId, { query: { role: "entry" } })).nodes[0],
        ).toEqual(root);
        h.screen.controller(session.sessionId, "agent", "agent");
        await allowForeground(h.screen, session.sessionId);
        expect(
          await h.screen.uiAct(
            session.sessionId,
            "agent",
            { ref: root.ref, action: "setValue", value: "updated" },
            "agent",
          ),
        ).toMatchObject({ fallback: false, method: "atspi" });
      } finally {
        await h.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
