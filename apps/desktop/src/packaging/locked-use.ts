import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Signed components are fixed siblings; the manifest supplies only their signing team. */
export const LockedUseManifest = z.object({ team: z.string().regex(/^[A-Z0-9]{10}$/) });
export const lockedUseFiles = {
  ACE_LOCKED_USE_PLUGIN: "AceLockedUseAuthorization.bundle",
  ACE_LOCKED_USE_BROKER: "ace-locked-use-authority",
  ACE_LOCKED_USE_GUARDIAN: "ace-locked-use-guardian",
} as const;

/** Missing assets keep unsigned/development builds unavailable. Partial packages fail loudly. */
export function lockedUseEnvironment(directory: string | undefined): NodeJS.ProcessEnv {
  if (!directory || !existsSync(directory)) return {};
  if (!existsSync(join(directory, "manifest.json")))
    throw new Error("The packaged locked-use manifest is missing.");
  const manifest = LockedUseManifest.parse(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
  );
  const env: NodeJS.ProcessEnv = { ACE_LOCKED_USE_TEAM: manifest.team };
  for (const [key, name] of Object.entries(lockedUseFiles)) {
    const path = join(directory, name);
    if (!existsSync(path)) throw new Error(`The packaged locked-use component is missing: ${path}`);
    env[key] = path;
  }
  return env;
}
