import {
  ComputerClient,
  graphicalSessionEnvironment,
  installScreenHelper,
  linuxComputerEnvironment,
  localScreenManager,
  screenConnection,
  type Simulators,
} from "@ace/screen";
import { nodeScheduler } from "@ace/mcp-server";
import { randomUUID } from "node:crypto";
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
  manager.configureAccess({
    enabled: () => settings.enabled(),
    enable: (enabled) => settings.enable(enabled),
    // Agent MCP notices are emitted by the result observer, covering pre-dispatch failures too.
    audit() {},
  });
  resources.own(() => manager.close());
  services.screen = manager;
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
            ...timings,
          })
        : undefined;
  if (!computer) return;
  resources.own(() => computer.close());
  services.computer = computer;
  services.computerUsing = new ComputerUsingThreads({ after: nodeScheduler.after });
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
