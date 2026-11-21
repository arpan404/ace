import { routeConsoleToStderr } from "@ace/provider-kit/console-guard";
import type { HostRuntime as Runtime } from "./host-runtime.ts";

// Stdout is the JSON-RPC channel, and Bun's console writes there directly. Static imports would
// evaluate ahead of this call, so console goes to stderr first and every module loads after it.
// hostWire installs the same guard again once it has patched stderr; doing so twice is harmless.
routeConsoleToStderr();
const { z } = await import("zod");
const { createRedactor } = await import("@ace/redaction");
const { boundedJson } = await import("@ace/provider-kit/ipc");
const { access } = await import("node:fs/promises");
const { writeSync } = await import("node:fs");
const { homedir, hostname } = await import("node:os");
const { join } = await import("node:path");
const { discoverCursorSdk } = await import("./host.ts");
const { hostWire } = await import("./host-wire.ts");
const { explainSandboxRefusal } = await import("./sandbox-helper.ts");
const { fatalLine } = await import("./host-fatal.ts");
const { safeCursorErrorMessage } = await import("./sdk-failure.ts");
const { probeCursorSandbox } = await import("./sandbox-support.ts");
const { HostRuntime } = await import("./host-runtime.ts");
const { snapshotInHost } = await import("./history.ts");
const { validateCursorAuthHome } = await import("./auth-home.ts");
const { cursorModelsInHost } = await import("./model-discovery.ts");
const { cursorAuthInHost } = await import("./auth-host.ts");
const { windowsArm64RipgrepPath } = await import("./ripgrep-path.ts");

// This entry is launched only by provider-kit with HOME set before any SDK import.
const admission = await discoverCursorSdk();
if (!admission.supported) process.exit(78);
if (process.platform === "win32") {
  // Windows ARM64 has no SDK ripgrep helper: point the SDK at ace's own rg.exe before it loads.
  const ripgrep = windowsArm64RipgrepPath(process.env, process.platform, process.arch);
  if (ripgrep) process.env.CURSOR_RIPGREP_PATH = ripgrep;
}
let runtime: Runtime | undefined;
let sdk: typeof import("@cursor/sdk") | undefined;
let ending = false;
const lifetime = new AbortController();
const graceMs = z.coerce
  .number()
  .int()
  .min(0)
  .max(30000)
  .parse(process.argv[2] ?? 5000);
if (process.platform === "win32") {
  // Windows has no process groups, so `stop` below can't kill its own group. Its stand-in ends
  // this host's own verified descendants first, so none outlives it even when the parent's job
  // could not contain the tree, then exits.
  const { endDescendantsSync } = await import("@ace/provider-kit/tree-stop");
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (pid !== -process.pid) return kill(pid, signal);
    endDescendantsSync();
    return process.exit(0);
  };
}
const stop = () => {
  if (ending) return;
  ending = true;
  lifetime.abort();
  // EOF survives daemon SIGKILL. Kill this owned POSIX group even if SDK cleanup hangs.
  const timer = setTimeout(() => process.kill(-process.pid, "SIGKILL"), graceMs);
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
  await validateCursorAuthHome(homedir());
  sdk ??= await import("@cursor/sdk");
  if (method === "status" || method === "login" || method === "logout")
    return cursorAuthInHost(method, {
      sdk,
      signal: lifetime.signal,
      environmentKeyPresent: () => process.env.CURSOR_API_KEY !== undefined,
      environmentKeyUsable: () => Boolean(process.env.CURSOR_API_KEY?.length),
      loginUrl: (url) => {
        void wire.notify("login-url", { url }).catch(stop);
      },
      keyName: `ace on ${hostname()}`.slice(0, 128),
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
    const safe: unknown = JSON.parse(
      scrub(
        boundedJson(
          await cursorModelsInHost(
            sdk,
            process.env.CURSOR_API_KEY === undefined
              ? undefined
              : Boolean(process.env.CURSOR_API_KEY.length),
          ),
          262144,
        ),
      ),
    );
    return safe;
  }
  const loaded = sdk;
  runtime ??= new HostRuntime(
    {
      ...loaded,
      sandboxSupport: (options) =>
        probeCursorSandbox(
          loaded,
          options,
          process.platform === "linux" ? () => explainSandboxRefusal() : undefined,
        ),
    },
    (frame) => wire.confirmed("frame", frame),
  );
  if (method === "open") return runtime.open(params);
  if (method === "configure") return runtime.configure(params);
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
// Name the uncaught error on stderr before stopping, so the parent can say why Cursor stopped.
const fatal = (kind: "uncaughtException" | "unhandledRejection") => (error: unknown) => {
  try {
    writeSync(
      2,
      fatalLine(
        kind,
        error,
        (text) =>
          runtime?.redactError(text) ??
          safeCursorErrorMessage(text, { CURSOR_API_KEY: process.env.CURSOR_API_KEY }),
      ),
    );
  } catch {
    // stderr already closed: stop anyway.
  }
  stop();
};
process.on("uncaughtException", fatal("uncaughtException"));
process.on("unhandledRejection", fatal("unhandledRejection"));
