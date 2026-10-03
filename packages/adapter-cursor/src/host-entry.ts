import { createRedactor } from "@ace/redaction";
import { boundedJson } from "@ace/provider-kit/ipc";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverCursorSdk } from "./host.ts";
import { hostWire } from "./host-wire.ts";
import { HostRuntime } from "./host-runtime.ts";
import { snapshotInHost } from "./history.ts";
import { cursorAuthInHost } from "./auth-host.ts";

// This entry is launched only by provider-kit with HOME set before any SDK import.
const admission = await discoverCursorSdk();
if (!admission.supported) process.exit(78);
let runtime: HostRuntime | undefined;
let sdk: typeof import("@cursor/sdk") | undefined;
let ending = false;
const lifetime = new AbortController();
const stop = () => {
  if (ending) return;
  ending = true;
  lifetime.abort();
  // EOF survives daemon SIGKILL. Kill this owned POSIX group even if SDK cleanup hangs.
  const timer = setTimeout(() => process.kill(-process.pid, "SIGKILL"), 5000);
  void runtime
    ?.close()
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer);
      process.kill(-process.pid, "SIGKILL");
    });
  if (!runtime) {
    clearTimeout(timer);
    process.kill(-process.pid, "SIGKILL");
  }
};
const wire = hostWire(async (method, params) => {
  sdk ??= await import("@cursor/sdk");
  if (method === "status" || method === "login" || method === "logout")
    return cursorAuthInHost(method, {
      sdk,
      signal: lifetime.signal,
      environmentKeyPresent: () => process.env.CURSOR_API_KEY !== undefined,
      loginUrl: (url) => {
        void wire.notify("login-url", { url }).catch(stop);
      },
      credentialFileAbsent: async () => {
        try {
          await access(join(homedir(), ".cursor", "sdk", "auth.json"));
          return false;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
          throw error;
        }
      },
    });
  if (method === "snapshot") return snapshotInHost(sdk, params);
  if (method === "models") {
    const scrub = createRedactor({ env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY } });
    const safe: unknown = JSON.parse(scrub(boundedJson(await sdk.Cursor.models.list(), 262144)));
    return safe;
  }
  runtime ??= new HostRuntime(sdk, (frame) => wire.notify("frame", frame));
  if (method === "open") return runtime.open(params);
  if (method === "send") return runtime.send(params);
  if (method === "cancel") {
    await runtime.cancel();
    return { settled: true };
  }
  if (method === "close") {
    await runtime.close();
    return { disposed: true };
  }
  throw new Error("Unsupported SDK operation");
}, stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
