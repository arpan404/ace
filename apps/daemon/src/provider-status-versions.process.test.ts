import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ProviderStatus } from "@ace/protocol";
import { ProviderStatuses } from "./provider-status.ts";
import { fakeCli } from "./provider-status-test-support.ts";
import { fixture } from "./socket-test-support.ts";

const codex = (rows: ProviderStatus[]) => rows.find((row) => row.provider === "codex");

test("update information that arrives after startup reaches clients without running the CLIs again", async () => {
  const home = await fixture();
  const bin = join(home.home, "bin");
  await mkdir(bin);
  await fakeCli(bin, "codex", "codex-cli 0.159.1", "Logged in using ChatGPT", "login status");
  // The update check needs the installers, which start after the first provider check.
  let installers = false;
  const statuses = new ProviderStatuses(
    {
      env: { HOME: home.home, PATH: bin },
      async versions(row) {
        if (!installers || row.provider !== "codex") return {};
        return { latestVersion: "0.160.0", updateAvailable: true, versionCheckedAt: 5 };
      },
    },
    { now: () => 1, schedule: () => () => {} },
  );
  try {
    await statuses.firstCheck();
    expect(codex(statuses.list())).toMatchObject({ installed: true, auth: "logged_in" });
    expect(codex(statuses.list())?.updateAvailable).toBeUndefined();
    const cliRuns = await readFile(join(bin, "calls"), "utf8");
    const pushed: ProviderStatus[][] = [];
    statuses.listen((rows) => pushed.push(rows));

    installers = true;
    await statuses.refreshVersions();

    expect(codex(statuses.list())).toMatchObject({
      installed: true,
      auth: "logged_in",
      version: "0.159.1",
      latestVersion: "0.160.0",
      updateAvailable: true,
    });
    expect(codex(pushed.at(-1) ?? [])).toMatchObject({ latestVersion: "0.160.0" });
    expect(await readFile(join(bin, "calls"), "utf8")).toBe(cliRuns);
  } finally {
    await statuses.close();
    await home.close();
  }
});
