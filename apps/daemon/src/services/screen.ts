import {
  ComputerClient,
  type ComputerClientOptions,
  graphicalSessionEnvironment,
  installScreenHelper,
  linuxComputerEnvironment,
  localScreenManager,
  screenConnection,
  type Simulators,
} from "@ace/screen";
import { nodeScheduler } from "@ace/mcp-server";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { LockedUseRuntime, lockedUseSocketPath } from "../locked-use-runtime.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ComputerUsingThreads } from "../computer-using.ts";
import { resolveScreenHelper } from "../screen-helper-path.ts";
import { ScreenSettings } from "../screen-settings.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startScreen({ config, options, resources, services, store }: ServiceContext) {
  const helper = resolveScreenHelper({
    platform: process.platform,
    configured: config.screenHelper,
    // A release runs one bundled entry file, so this is the bundle's directory.
    bundleDirectory: import.meta.dirname,
    exists: existsSync,
  });
  // Linux: the desktop session is read from the user manager each time a helper starts.
  const session =
    process.platform === "linux" ? graphicalSessionEnvironment({ env: process.env }) : undefined;
  const manager =
    options.screen ??
    (helper
      ? localScreenManager(helper, join(config.dataDir, "screen-artifacts"), {
          manifest: config.screenHelperManifest,
          inheritResponsibility: config.screenHelperInheritsResponsibility,
          session,
        })
      : undefined);
  if (!manager) return;
  const settings = new ScreenSettings(store);
  // Linux: once computer use is on, accessibility is turned on for the desktop session, so the
  // apps the person opens from then on can be seen. Firefox reads it only when it starts, and
  // only a helper that has connected to the accessibility bus turns it on.
  let wakeAccessibility: (() => void) | undefined;
  manager.configureAccess({
    enabled: () => settings.enabled(),
    enable: (enabled) => {
      settings.enable(enabled);
      if (enabled) wakeAccessibility?.();
    },
    // Agent MCP notices are emitted by the result observer, covering pre-dispatch failures too.
    audit() {},
  });
  resources.own(() => manager.close());
  services.screen = manager;
  if (options.computer) {
    services.computer = options.computer;
    services.computerUsing = new ComputerUsingThreads({ after: nodeScheduler.after });
    return;
  }
  if (!helper || options.screen) return;
  // Opt-in per-action timings, written to stderr as JSON lines.
  const timings = config.computerUseTimings
    ? {
        timing: {
          report: (entry: object) => {
            process.stderr.write(`${JSON.stringify({ component: "computer-use", ...entry })}\n`);
          },
        },
      }
    : {};
  if (process.platform === "win32") {
    const computer = windowsComputerClient(helper, config.dataDir, timings);
    resources.own(() => computer.close());
    services.computer = computer;
    services.computerUsing = new ComputerUsingThreads({ after: nodeScheduler.after });
    return;
  }
  const computer =
    process.platform === "darwin"
      ? // Same signed helper, so the person's Accessibility and Screen Recording grants apply.
        new ComputerClient({
          helper: () => installScreenHelper(helper, config.dataDir, config.screenHelperManifest),
          nextId: randomUUID,
          ...timings,
        })
      : session
        ? // The live-view helper binary; `--computer` selects the background engine.
          new ComputerClient({
            helper: async () => helper,
            nextId: randomUUID,
            environment: linuxComputerEnvironment(session),
            // Wayland screen-sharing approvals (portal restore tokens) outlive the helper.
            helperArgs: ["--data-dir", join(config.dataDir, "screen")],
            // The helper restores a borrowed clipboard and releases held keys when stdin closes.
            stopGraceMs: 1_000,
            ...timings,
          })
        : undefined;
  if (!computer) return;
  if (session) {
    wakeAccessibility = () => {
      // No session yet, or none at all: the first look tries again.
      computer.request("hello", {}).catch(() => {});
    };
    if (settings.enabled()) wakeAccessibility();
  }
  resources.own(() => computer.close());
  services.computer = computer;
  if (process.platform === "darwin") {
    // Started only when a gated call needs it: with locked use off it never runs.
    const lockedUse = new LockedUseRuntime({
      helper: () => installScreenHelper(helper, config.dataDir, config.screenHelperManifest),
      socketPath: lockedUseSocketPath(config.dataDir),
      nextId: randomUUID,
      attemptId: () => randomBytes(32).toString("base64url"),
      scheduler: { after: nodeScheduler.after },
    });
    resources.own(() => lockedUse.close());
    services.lockedUseRuntime = lockedUse;
  }
  services.computerUsing = new ComputerUsingThreads({ after: nodeScheduler.after });
}
/**
 * Windows computer use: the session helper's executable, where `--computer` selects the
 * background engine. Paths the agent names for executables outside the Start menu are
 * remembered under the data dir. `extra` adds timings, or a test's spawner.
 */
export function windowsComputerClient(
  helper: string,
  dataDir: string,
  extra: Partial<ComputerClientOptions> = {},
): ComputerClient {
  return new ComputerClient({
    helper: async () => helper,
    nextId: randomUUID,
    helperArgs: ["--data-dir", join(dataDir, "screen")],
    // The helper restores a borrowed clipboard and releases held keys when stdin closes.
    stopGraceMs: 1_000,
    // A console program started from a windowless daemon would open a console window.
    spawnHelper: (command, args, env) =>
      spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    ...extra,
  });
}

export function createScreenSession(context: SocketContext, simulators: Simulators): SocketService {
  let channel: ReturnType<typeof screenConnection> | undefined;
  return {
    authenticated(kind) {
      // Screen state belongs on the main and screen channels; a devices channel can't parse it.
      if (kind !== undefined && kind !== "screen") return;
      if (!context.options.screen || !context.authorize("admin")) return;
      channel = screenConnection(context.options.screen, simulators, context.sessionId, {
        send: context.send,
        // Video for a helper that makes only JPEG (Linux, Windows): ace's encoder-only Chrome.
        pictureEncoder: () => context.options.browser?.videoEncoder(),
        media: {
          bufferedBytes: () => context.socket.bufferedAmount,
          write: (piece) =>
            new Promise<void>((resolve, reject) => {
              if (!context.connected() || !context.authorize("admin"))
                return reject(new Error("Screen socket revoked"));
              context.socket.send(piece, { binary: true, compress: false }, (error) =>
                error ? reject(error) : resolve(),
              );
            }),
        },
      });
    },
    close() {
      channel?.close();
    },
    handle(message) {
      if (message.type === "screen.ack") {
        // Fire and forget: a stale or refused ack only leaves that viewer's window as it was.
        try {
          if (context.authorize("admin")) channel?.ack(message);
        } catch (error) {
          context.options.log?.(error);
        }
        return true;
      }
      if (message.type !== "screen.request") return false;
      if (!context.authorize("admin"))
        context.send({
          type: "screen.result",
          requestId: message.requestId,
          ok: false,
          errorCode: "forbidden",
          error: "Admin scope required for screen access",
        });
      else if (!channel)
        context.send({
          type: "screen.result",
          requestId: message.requestId,
          ok: false,
          errorCode: "screen_disabled",
          error: "Screen capability is not configured",
        });
      else {
        const task = channel
          .request(message)
          .catch((error: unknown) => {
            context.options.log?.(error);
            context.send({
              type: "screen.result",
              requestId: message.requestId,
              ok: false,
              errorCode: "internal",
              error: "Screen request failed",
            });
          })
          .finally(() => context.tasks.delete(task));
        context.tasks.add(task);
      }
      return true;
    },
  };
}
