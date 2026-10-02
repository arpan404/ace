import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import type { Check } from "@ace/diagnostics";
import type { Config } from "./config.ts";
/** Remote-specific checks extend the shared registry without another doctor implementation. */
export function remoteDoctorChecks(config: Config, env: NodeJS.ProcessEnv): Check[] {
  if (config.listen === "local") return [];
  const fix = "Install OpenSSL and add it to PATH before starting remote TLS.";
  return [
    {
      id: "remote.openssl",
      fix,
      run: async (signal) => {
        const path = await findExecutable("openssl", env);
        if (!path) return { status: "fail", message: "OpenSSL is missing for remote TLS", fix };
        const result = await probeOutput(path, ["version"], {
          env,
          signal,
          timeoutMs: 4000,
          maxBytes: 4096,
        });
        const version = /^(?:OpenSSL|LibreSSL) [\w.+-]+/.exec(result.stdout)?.[0];
        return {
          status: result.code === 0 && version ? "ok" : "fail",
          message: version ?? "OpenSSL version probe failed",
          fix,
        };
      },
    },
  ];
}
