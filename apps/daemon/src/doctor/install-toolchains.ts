import type { Toolchain } from "@ace/protocol";
import type { Verdict } from "./install-versions.ts";

/** Optional tools doctor reports on. git is a base check, so it isn't repeated here. */
export const optionalTools = {
  xcode: { name: "Xcode", purpose: "the iOS Simulator" },
  android: { name: "Android SDK", purpose: "Android emulators" },
} as const;

export type OptionalTool = keyof typeof optionalTools;

/**
 * An optional tool never fails doctor: missing reads as ok with what it's for, and the setup
 * hint goes in `fix`.
 */
export function toolchainVerdict(id: OptionalTool, found: Toolchain | undefined): Verdict {
  const tool = optionalTools[id];
  if (!found?.available)
    return {
      status: "ok",
      message: `${tool.name} not installed; needed only for ${tool.purpose}`,
      fix: found?.hint ?? `Install ${tool.name} to use ${tool.purpose}.`,
    };
  return {
    status: "ok",
    message:
      `${tool.name}${found.version ? ` ${found.version}` : ""} found (${found.detail}), for ${tool.purpose}`.slice(
        0,
        2048,
      ),
    fix: "Nothing to do.",
  };
}
