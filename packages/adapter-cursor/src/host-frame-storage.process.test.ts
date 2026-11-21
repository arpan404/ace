import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CursorHost } from "./host.ts";
import { bearer, runtimeFixture } from "./host-runtime-test-support.ts";

const wire = new URL("./host-wire.ts", import.meta.url).pathname;
const frame = {
  schemaVersion: 1,
  operationId: "op",
  generation: "gen",
  segment: 0,
  kind: "delta",
  body: {},
};

async function hostFrom(source: string) {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-storage-"));
  const entry = join(root, "host.ts");
  await writeFile(entry, source);
  // ace's own storage fails, the way a locked SQLite write does.
  const host = new CursorHost({ env: { HOME: root }, entry, generation: () => "gen" }, () => {
    throw new Error("database is locked");
  });
  return {
    host,
    async [Symbol.asyncDispose]() {
      await host.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("a frame ace fails to store is reported to the host as ace's storage failure", async () => {
  await using fixture = await hostFrom(
    `import { hostWire } from ${JSON.stringify(wire)};
const wire = hostWire(async (method) => {
  if (method !== "send") return { alive: true };
  try {
    await wire.confirmed("frame", ${JSON.stringify(frame)}, () => 30_000);
    return { stored: true };
  } catch (error) {
    return { stored: false, reason: error instanceof Error ? error.message : String(error) };
  }
}, () => process.exit(0));
`,
  );
  const reply = await fixture.host.request("send");
  expect(reply).toEqual({ stored: false, reason: expect.any(String) as unknown });
  const { reason } = reply as { reason: string };
  expect(reason).toMatch(/^ace could not store a Cursor SDK frame/);
  expect(reason).toContain("database is locked");
});

it("a host stopped because ace failed to store its frame names ace's storage as the cause", async () => {
  await using fixture = await hostFrom(
    `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "frame", params: ${JSON.stringify(frame)} }) + "\\n");
setInterval(() => {}, 1000);
`,
  );
  await fixture.host.process.exited;
  expect(fixture.host.stopCause).toMatch(/^ace could not store a Cursor SDK frame/);
  expect(fixture.host.stopCause).toContain("database is locked");
});

// The daemon stores what the host sends as is, so the host must redact the session's MCP bearer
// in every frame body, a Cursor error's included.
it("the session's MCP bearer in a Cursor error or message never reaches ace's storage", async () => {
  const stored: string[] = [];
  const settled = Promise.withResolvers<void>();
  await using fixture = await runtimeFixture(
    {},
    async (envelope) => {
      stored.push(JSON.stringify(envelope));
      if (envelope.kind === "result") settled.resolve();
    },
    {
      message: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `lease ${bearer}` }] },
      },
      runError: `MCP call failed with bearer ${bearer}`,
    },
  );
  await fixture.open({ url: "http://127.0.0.1:4321/mcp", bearer });
  await fixture.send("first");
  await settled.promise;
  expect(stored.join("\n")).toContain("MCP call failed");
  expect(stored.join("\n")).not.toContain(bearer);
});
