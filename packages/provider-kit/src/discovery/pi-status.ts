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
  let provider: string | undefined;
  try {
    const file = await open(
      join(env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent"), "settings.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
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
  } catch (error) {
    // An absent file is normal before first login; rejected settings must never reach the CLI.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      return { ...result, error: "Pi settings or readiness probe unavailable" };
  }
  if (result.version !== "0.85.1" && result.version !== "1.1.0")
    return { ...result, error: "Pi auth status is unsupported for this version" };
  const providers = [
    ...new Set([...(provider ? [provider] : []), "openai-codex", "anthropic", "github-copilot"]),
  ];
  const executable = result.path;
  const statuses = await Promise.all(
    providers.map(async (upstream) => {
      try {
        const output = await (options.probe ?? probeOutput)(
          executable,
          ["auth", "check", "--provider", upstream, "--json", "--no-refresh"],
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
        return { auth, authDetail: status.authType };
      } catch {
        return { auth: "unknown" as const, authDetail: undefined };
      }
    }),
  );
  const ready = statuses.find((status) => status.auth === "logged_in");
  if (ready)
    return {
      ...result,
      auth: "logged_in",
      ...(ready.authDetail ? { authDetail: ready.authDetail } : {}),
    };
  const signedOut = statuses.every((status) => status.auth === "logged_out");
  return {
    ...result,
    auth: signedOut ? "logged_out" : "unknown",
    ...(!signedOut ? { error: "Pi readiness could not be determined" } : {}),
  };
}
