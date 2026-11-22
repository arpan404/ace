import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../store.ts";
import { startSupportFiles } from "./support-files.ts";
import type { ServiceContext } from "./types.ts";

// ADR 0209 §3: a conversation bundle started while the machine was a person's is never published
// once the machine has become an organization's host.

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("a conversation bundle that finishes after enrollment is not published", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ace-support-"));
  homes.push(dataDir);
  // The conversations a bundle would carry.
  const store = new Store(join(dataDir, "events.sqlite"));
  let org: string | undefined;
  const owned: (() => unknown)[] = [];
  const services: Record<string, unknown> = {};
  let n = 0;
  const context = {
    config: { dataDir },
    now: () => 1,
    id: () => `id${++n}`,
    signal: new AbortController().signal,
    resources: { own: (close: () => unknown) => owned.push(close) },
    services,
    // Enrolled while the bundle is being written.
    options: {
      diagnostics: {
        doctor: async () => {
          org = "org_acme";
          return { at: 1, checks: [] };
        },
      },
    },
    orgHost: { org: () => org, bind: () => {} },
  } as unknown as ServiceContext;
  await startSupportFiles(context);
  const files = services["supportFiles"] as {
    request(device: string, input: unknown): Promise<unknown>;
    close(): Promise<void>;
  };
  await expect(
    files.request("host", { op: "artifact.support", includeThreads: true }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Without conversations, the same machine still exports.
  await expect(files.request("host", { op: "artifact.support" })).resolves.toMatchObject({
    artifactId: expect.stringMatching(/^support-/),
  });
  for (const close of owned) await close();
  store.close();
});
