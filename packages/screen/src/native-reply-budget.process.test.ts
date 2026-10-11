import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { expect, it } from "vitest";
import { probeOutput } from "@ace/provider-kit/process";
import { windowsFixture } from "./testing/windows-fixture.ts";

// Build with cargo build --manifest-path native/screen-helper-windows/Cargo.toml --example wire_fixture.
// Running the built serializer preserves the test's isolated home without toolchain downloads.
const nativeFixture =
  new URL(
    "../../../native/screen-helper-windows/target/debug/examples/wire_fixture",
    import.meta.url,
  ).pathname + (process.platform === "win32" ? ".exe" : "");
const nativeReply = z.object({ ok: z.literal(true), data: z.unknown() });
it.skipIf(!existsSync(nativeFixture))(
  "dense native Windows trees and searches preserve capture and subsequent inspection",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ace-native-replies-"));
    try {
      for (const nodes of [128, 512]) {
        const generated = await probeOutput(nativeFixture, [String(nodes)], { timeoutMs: 30_000 });
        expect(generated.code, generated.stderr).toBe(0);
        const [treeLine, findLine] = generated.stdout.trim().split("\n");
        if (!treeLine || !findLine) throw new Error("Missing native inspection replies");
        expect(Buffer.byteLength(treeLine)).toBeLessThanOrEqual(64 * 1024);
        const tree = nativeReply.parse(JSON.parse(treeLine)).data;
        const find = nativeReply.parse(JSON.parse(findLine)).data;
        const path = join(directory, "replies.json");
        await writeFile(path, JSON.stringify({ tree, find }));
        const h = await windowsFixture({ env: { NATIVE_UI_REPLIES: path } });
        try {
          const session = await h.start();
          const inspected = await h.manager.uiTree(session.sessionId, { maxNodes: nodes });
          expect(inspected.truncated).toBe(true);
          expect(inspected.nodes[0]?.children.length).toBeGreaterThan(0);
          const found = await h.manager.uiFind(session.sessionId, {
            query: { role: "button" },
            limit: 64,
          });
          expect(found.truncated).toBe(true);
          expect(found.nodes.length).toBeGreaterThan(0);
          expect(await h.manager.uiTree(session.sessionId, { maxNodes: nodes })).toEqual(inspected);
          expect((await h.manager.targets()).windows).toHaveLength(1);
          expect((await h.manager.screenshot(session.sessionId)).payload.toString()).toContain(
            "v2-jpeg",
          );
        } finally {
          await h.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
