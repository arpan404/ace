/*
 * macOS ties the person's Screen Recording grant to the helper's designated requirement. The
 * built AceScreenHelper.app must keep the one recorded in native/screen-helper/identity.txt,
 * or every Mac would ask for the permission again (docs/media/plan.md, "Helper changes").
 * A build signed ad hoc (no Developer ID in the keychain) has no stable requirement to check.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeOutput } from "@ace/provider-kit/process";

const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;

it.runIf(process.platform === "darwin")(
  "the built screen helper keeps the designated requirement in identity.txt",
  { timeout: 300_000 },
  async (context) => {
    expect(
      (await probeOutput("sh", [join(directory, "build.sh")], { timeoutMs: 300_000 })).code,
    ).toBe(0);
    if (readFileSync(join(directory, "build/signing-identity"), "utf8").trim() === "-") {
      context.skip("Signed ad hoc: no Developer ID identity in this keychain");
      return;
    }
    const shown = spawnSync(
      "codesign",
      ["-d", "-r-", join(directory, "build/AceScreenHelper.app")],
      {
        encoding: "utf8",
      },
    );
    expect(shown.status).toBe(0);
    const requirement = `${shown.stdout}${shown.stderr}`
      .split("\n")
      .find((line) => line.startsWith("designated => "));
    expect(requirement).toBe(readFileSync(join(directory, "identity.txt"), "utf8").trim());
  },
);
