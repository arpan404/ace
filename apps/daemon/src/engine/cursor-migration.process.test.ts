import { Store } from "@ace/daemon";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { discoverAdapters } from "./adapters.ts";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "fixture" };
it("Cursor discovery selects only the SDK, even when an old client supplies ACP", async () => {
  const registry = await discoverAdapters(
    async () => ({
      claude: absent,
      codex: absent,
      opencode: absent,
      cursor: { ...absent, installed: true },
    }),
    undefined,
    async () => {},
    {},
    async () => ({ installed: true, supported: true, version: "1.0.35" }),
  );
  expect(registry.get("cursor", "acp").adapter.backend).toBe("cursor-sdk");
  const missing = await discoverAdapters(
    async () => ({
      claude: absent,
      codex: absent,
      opencode: absent,
      cursor: { ...absent, installed: true },
    }),
    undefined,
    async () => {},
    {},
    async () => ({ installed: false, supported: false }),
  );
  expect(missing.has("cursor")).toBe(false);
  await registry.close();
  await missing.close();
});

it.each(["acp", "transitions", "provider_metadata"] as const)(
  "a daemon database without the %s thread column is refused, not repaired",
  async (missing) => {
    const home = await mkdtemp(join(tmpdir(), "cursor-acp-schema-"));
    try {
      const path = join(home, "events.sqlite");
      const store = new Store(path);
      store.createWorkspace(home, "Metadata workspace");
      store.close();
      const db = new DatabaseSync(path);
      try {
        db.exec(`ALTER TABLE threads DROP COLUMN ${missing}`);
      } finally {
        db.close();
      }
      expect(() => new Store(path)).toThrow(
        expect.objectContaining({
          code: "incompatible-data",
          message: expect.stringContaining(`lacks thread columns ${missing}`),
        }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
