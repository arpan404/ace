import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProviderStatuses } from "./provider-status.ts";

test("provider cards skip disabled CLI discovery and probe an enabled custom Antigravity executable", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-cards-"));
  const marker = join(home, "invoked");
  const binary = join(home, "custom-agy");
  let enabled = false;
  let statuses: ProviderStatuses | undefined;
  try {
    await writeFile(
      binary,
      `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'version'); console.log('Antigravity 1.20.0');\n`,
      { mode: 0o700 },
    );
    statuses = new ProviderStatuses(
      {
        env: { HOME: home, PATH: home },
        configuration: (provider) => ({
          enabled: provider === "antigravity" && enabled,
          binaryPath: binary,
        }),
      },
      { now: () => 7, schedule: () => () => {} },
    );
    await statuses.refresh();
    expect(statuses.list().every((row) => row.enabled === false)).toBe(true);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    enabled = true;
    await statuses.refresh();
    expect(statuses.list().find((row) => row.provider === "antigravity")).toMatchObject({
      enabled: true,
      installed: true,
      path: binary,
      auth: "unknown",
    });
    expect(await readFile(marker, "utf8")).toBe("version");
  } finally {
    await statuses?.close();
    await rm(home, { recursive: true, force: true });
  }
});
