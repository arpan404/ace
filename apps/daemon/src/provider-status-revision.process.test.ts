import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProviderStatuses } from "./provider-status.ts";

/** The SDK probe records the sign-in it reads, which advances the account's login revision. */
async function cursorStatus(concurrentLogin: boolean) {
  const home = await mkdtemp(join(tmpdir(), "ace-status-revision-"));
  let revision = 0;
  const statuses = new ProviderStatuses(
    {
      env: { HOME: home, PATH: home },
      configuration: (provider) => (provider === "cursor" ? { revision: String(revision) } : {}),
      cursorSdk: async () => {
        revision++;
        const observedRevision = String(revision);
        if (concurrentLogin) revision++;
        return { installed: true, auth: "logged_in", loginHint: "", observedRevision };
      },
    },
    { now: () => 1000, schedule: () => () => {} },
  );
  try {
    await statuses.refresh();
    return statuses.list().find((row) => row.provider === "cursor");
  } finally {
    await statuses.close();
    await rm(home, { recursive: true, force: true });
  }
}

test("a probe's own sign-in observation does not discard its result", async () => {
  expect(await cursorStatus(false)).toMatchObject({
    installed: true,
    auth: "logged_in",
    stale: false,
  });
});

test("a sign-in that changes after the probe observed it discards the probe's result", async () => {
  expect(await cursorStatus(true)).toMatchObject({ installed: null, auth: "unknown" });
});
