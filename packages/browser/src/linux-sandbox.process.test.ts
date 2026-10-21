import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { chromiumArtifact } from "./chromium-manifest.ts";
import {
  chromiumAppArmorInstall,
  chromiumAppArmorProfile,
  chromiumAttachmentFor,
} from "./linux-sandbox.ts";

const parser = spawnSync("apparmor_parser", ["--version"]).status === 0;

/** What AppArmor makes of `profile`, without loading it into the kernel. */
async function parsed(profile: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-apparmor-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "ace-chromium");
  await writeFile(path, profile);
  const result = spawnSync("apparmor_parser", ["-QK", "-d", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`apparmor_parser failed: ${result.stderr}`);
  // The parser prints the profile mode on stderr.
  return `${result.stdout}\n${result.stderr}`;
}

it.skipIf(!parser)(
  "the AppArmor profile grants user namespaces to ace's pinned Chrome on both Linux architectures",
  async () => {
    const debug = await parsed(chromiumAppArmorProfile());
    expect(debug).toMatch(/Mode:\s+unconfined/);
    expect(debug).toMatch(/^userns,$/m);
    const attachment = /^Attachment:\s+(.+)$/m.exec(debug)?.[1] ?? "";
    expect(attachment).toContain("/.ace/chromium/*/chrome-linux{64,-arm64}/chrome");
    // The glob covers the executable each Linux pin unpacks to.
    expect(["x64", "arm64"].map((arch) => chromiumArtifact("linux", arch).executable)).toEqual([
      "chrome-linux64/chrome",
      "chrome-linux-arm64/chrome",
    ]);
  },
);

it.skipIf(!parser)(
  "a custom ACE_HOME with spaces and glob characters gets a profile matching only itself",
  async () => {
    const debug = await parsed(chromiumAppArmorProfile(chromiumAttachmentFor("/srv/ace home[1]")));
    expect(/^Attachment:\s+(.+)$/m.exec(debug)?.[1]).toContain("/srv/ace home\\[1\\]/chromium/");
  },
);

it("the install steps write the profile where the package installs it and load it", () => {
  const steps = chromiumAppArmorInstall();
  expect(steps).toContain("sudo tee /etc/apparmor.d/ace-chromium");
  expect(steps).toContain(chromiumAppArmorProfile().trimEnd());
  expect(steps.trimEnd().split("\n").at(-1)).toBe(
    "sudo apparmor_parser -r /etc/apparmor.d/ace-chromium",
  );
});
