import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { CursorHost } from "./host.ts";

// The session's ace MCP bearer: bare hex, which only an exact-value redaction catches.
const bearer = "7f3a9c1e5b8d2f4a6c0e9b7d5f3a1c8e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a";

async function fixture(source: string, extension = "mjs") {
  const root = await mkdtemp(join(tmpdir(), "cursor-stray-"));
  const entry = join(root, `host.${extension}`);
  await writeFile(entry, source);
  return {
    root,
    entry,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

// The host's own stderr budget cut a line before ace could redact the bearer in it, leaving a
// fragment no exact-value match finds.
it("a bearer straddling the host's stderr line budget never reaches ace's failure evidence", async () => {
  const wire = new URL("./host-wire.ts", import.meta.url).pathname;
  const files = await fixture(
    `
import { hostWire } from ${JSON.stringify(wire)};
hostWire(async () => {
  await new Promise((resolve) =>
    process.stderr.write("detail " + "x".repeat(4072) + " " + ${JSON.stringify(bearer)} + " tail\\n", resolve),
  );
  return { models: [] };
}, () => process.exit(0));
`,
    "ts",
  );
  const host = new CursorHost(
    {
      env: { HOME: files.root },
      entry: files.entry,
      secrets: { ACE_MCP_BEARER: bearer },
    },
    () => {},
  );
  try {
    await expect(host.request("models")).resolves.toEqual({ models: [] });
    await sleep(100);
    expect(host.failureMessage).toContain("detail");
    expect(host.failureMessage).not.toContain(bearer.slice(0, 12));
  } finally {
    await host.stop();
    await files.remove();
  }
});
