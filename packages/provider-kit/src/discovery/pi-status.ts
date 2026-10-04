import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discoverPi } from "./pi.ts";
import type { DiscoveryOptions } from "./index.ts";
import type { DiscoveryResult } from "./types.ts";
import { probeOutput } from "../process.ts";

/** Only non-secret settings select the native readiness check. Never open Pi's auth files. */
export async function discoverPiStatus(
  options: Omit<DiscoveryOptions, "overrides"> & { executable?: string } = {},
): Promise<DiscoveryResult> {
  const result = await discoverPi(options);
  if (!result.installed || !result.path) return result;
  const env = { ...process.env, ...options.env };
  try {
    const file = await open(
      join(env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent"), "settings.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let provider: string | undefined;
    try {
      if (!(await file.stat()).isFile()) throw new Error("Settings must be a regular file");
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new Error("Settings too large");
      provider = z
        .object({
          defaultProvider: z
            .string()
            .regex(/^[a-zA-Z0-9._-]{1,128}$/)
            .optional(),
        })
        .parse(JSON.parse(buffer.toString("utf8", 0, bytesRead))).defaultProvider;
    } finally {
      await file.close();
    }
    if (!provider)
      return { ...result, error: "Pi has no configured default provider; auth status is unknown" };
    // This command is audited for 0.85.1. Unknown versions must not accidentally enter a session.
    if (result.version !== "0.85.1")
      return { ...result, error: "Pi auth status is unsupported for this version" };
    const output = await (options.probe ?? probeOutput)(
      result.path,
      ["auth", "check", "--provider", provider, "--json", "--no-refresh"],
      {
        env,
        timeoutMs: options.timeoutMs ?? 4000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const status = z
      .object({
        status: z.enum(["ready", "not_ready", "invalid"]),
        reason: z.string().optional(),
        authType: z.enum(["api_key", "oauth"]).optional(),
      })
      .parse(JSON.parse(output.stdout));
    const auth =
      status.status === "ready" && output.code === 0
        ? "logged_in"
        : status.status === "not_ready" &&
            (status.reason === "credentials_not_configured" ||
              status.reason === "credential_not_available")
          ? "logged_out"
          : "unknown";
    return {
      ...result,
      auth,
      ...(status.authType ? { authDetail: status.authType } : {}),
      ...(auth === "unknown" ? { error: "Pi readiness could not be determined" } : {}),
    };
  } catch {
    return { ...result, auth: "unknown", error: "Pi settings or readiness probe unavailable" };
  }
}
