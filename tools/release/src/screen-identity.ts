import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";

export const ScreenHelperIdentity = z.object({
  requirement: z.string().min(1),
  teamId: z.string().min(1),
  bundleId: z.string().min(1),
});
export type ScreenHelperIdentity = z.infer<typeof ScreenHelperIdentity>;

export function readScreenHelperIdentity(app: string): ScreenHelperIdentity {
  const result = spawnSync("codesign", ["-dvv", "-r-", app], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  const bundleId = execFileSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents/Info.plist")],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  return parseScreenHelperIdentity(result.stdout + result.stderr, bundleId);
}

export function parseScreenHelperIdentity(display: string, bundleId: string): ScreenHelperIdentity {
  // Ad-hoc signatures print their implicit cdhash requirement with a comment prefix.
  const lines = display.split("\n").map((line) => line.replace(/^# (?=designated => )/, ""));
  return ScreenHelperIdentity.parse({
    requirement: lines.find((line) => line.startsWith("designated => ")),
    teamId: lines
      .find((line) => line.startsWith("TeamIdentifier="))
      ?.slice("TeamIdentifier=".length),
    bundleId,
  });
}

export function assertScreenHelperIdentity(
  before: ScreenHelperIdentity,
  after: ScreenHelperIdentity,
): void {
  for (const field of ["requirement", "teamId", "bundleId"] as const)
    if (before[field] !== after[field])
      throw new Error(
        `Screen helper ${field} changed during packaging: Screen Recording grants would be lost`,
      );
}
