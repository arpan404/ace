import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { CursorHost } from "./host.ts";

const wire = new URL("./host-wire.ts", import.meta.url).pathname;

/** A real hostWire child whose "send" stores one frame, waiting at most `ackMs` for the ack. */
async function hostStoringOneFrame(ackMs: number) {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-ack-"));
  const entry = join(root, "host.ts");
  await writeFile(
    entry,
    `import { hostWire } from ${JSON.stringify(wire)};
const frame = { schemaVersion: 1, operationId: "op", generation: "gen", segment: 0, kind: "delta", body: {} };
const wire = hostWire(async (method) => {
  if (method !== "send") return { alive: true };
  try {
    await wire.confirmed("frame", frame, ${ackMs});
    return { stored: true };
  } catch (error) {
    return { stored: false, reason: error instanceof Error ? error.message : String(error) };
  }
}, () => process.exit(0));
`,
  );
  return { root, entry };
}

// A busy daemon (fsync, a long transaction) can answer a frame after the host stopped waiting.
it("a storage acknowledgement that arrives after the host stopped waiting leaves the host running", async () => {
  const { root, entry } = await hostStoringOneFrame(100);
  const stored = Promise.withResolvers<void>();
  const host = new CursorHost({ env: { HOME: root }, entry, generation: () => "gen" }, async () => {
    await sleep(400);
    stored.resolve();
  });
  try {
    await expect(host.request("send")).resolves.toEqual({
      stored: false,
      reason: expect.stringMatching(/acknowledgement expired/) as unknown,
    });
    await stored.promise;
    // The late reply is now on the host's stdin; the host must keep answering.
    await sleep(100);
    await expect(host.request("ping")).resolves.toEqual({ alive: true });
    expect(host.process.signal.aborted).toBe(false);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
