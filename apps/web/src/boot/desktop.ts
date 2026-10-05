import { DaemonTarget } from "./connection-settings.ts";

/**
 * In the Electron app the preload bridge (`window.ace`) hands over the daemon address and
 * token, never through the URL (ADR 0045). In a browser there is no bridge. Everything the
 * bridge returns is checked here before the app uses it.
 */
/** Whether this page runs inside the desktop app (its preload bridge is present). */
export function hasDesktopBridge(scope: object = globalThis): boolean {
  return daemonBridge(scope) !== undefined;
}

/** What the desktop app said about its daemon at boot. */
export type DesktopConnection =
  /** No bridge (a browser), or the desktop's fake mode: the browser flow applies. */
  | { kind: "none" }
  | { kind: "target"; target: DaemonTarget }
  /**
   * The daemon couldn't be handed over. `remoteOnly`: this computer runs no daemon, so the
   * person connects to one elsewhere; otherwise the local daemon failed to start.
   */
  | { kind: "failed"; reason: string; remoteOnly: boolean };

export async function desktopConnection(scope: object = globalThis): Promise<DesktopConnection> {
  const daemon = daemonBridge(scope);
  if (!daemon || typeof daemon.connection !== "function") return { kind: "none" };
  let handed: unknown;
  try {
    handed = await daemon.connection();
  } catch (error) {
    return {
      kind: "failed",
      reason: bridgeMessage(error),
      remoteOnly: (await desktopStatus(scope))?.state === "unavailable",
    };
  }
  const parsed = DaemonTarget.safeParse(handed);
  return parsed.success ? { kind: "target", target: parsed.data } : { kind: "none" };
}

/** The desktop's view of its daemon (`DaemonStatus` in apps/desktop), as far as the web uses it. */
export interface DesktopDaemonStatus {
  state: string;
  message?: string | undefined;
}

/** One check of `ace doctor --json`: what the "Run diagnostics" button shows. */
export interface DiagnosticCheck {
  id: string;
  status: string;
  message: string;
  fix?: string | undefined;
}

/** The desktop's daemon controls for its failure and starting screens; undefined in a browser. */
export interface DesktopDaemon {
  status(): Promise<DesktopDaemonStatus | undefined>;
  onStatus(listener: (status: DesktopDaemonStatus) => void): () => void;
  restart(): Promise<DesktopDaemonStatus | undefined>;
  diagnose(): Promise<DiagnosticCheck[]>;
  /** Absent on a desktop build that predates it. */
  showLogs?(): Promise<boolean>;
  quit?(): Promise<void>;
}

export function desktopDaemon(scope: object = globalThis): DesktopDaemon | undefined {
  const daemon = daemonBridge(scope);
  if (!daemon) return undefined;
  const app = record(Reflect.get(scope, "ace"))?.app;
  const statusCall = call(daemon, "status");
  const restartCall = call(daemon, "restart");
  const diagnoseCall = call(daemon, "diagnose");
  const onStatusCall = call(daemon, "onStatus");
  const showLogsCall = call(daemon, "showLogs");
  const quitCall = call(record(app), "quit");
  return {
    status: async () => parseStatus(await statusCall?.()),
    restart: async () => parseStatus(await restartCall?.()),
    async diagnose() {
      if (!diagnoseCall) return [];
      const report = record(await diagnoseCall());
      const checks = Array.isArray(report?.checks) ? report.checks : [];
      return checks.flatMap((check: unknown) => {
        const value = record(check);
        if (!value || typeof value.id !== "string" || typeof value.message !== "string") return [];
        return [
          {
            id: value.id,
            status: typeof value.status === "string" ? value.status : "unknown",
            message: value.message,
            fix: typeof value.fix === "string" ? value.fix : undefined,
          },
        ];
      });
    },
    onStatus(listener) {
      const stop = onStatusCall?.((value: unknown) => {
        const status = parseStatus(value);
        if (status) listener(status);
      });
      return typeof stop === "function" ? () => void stop() : () => {};
    },
    ...(showLogsCall ? { showLogs: async () => (await showLogsCall()) === true } : {}),
    ...(quitCall ? { quit: async () => void (await quitCall()) } : {}),
  };
}

/** A bridge method, bound to its object, if the bridge has it. */
function call(target: Record<string, unknown> | undefined, name: string) {
  const method = target?.[name];
  return typeof method === "function"
    ? (...args: unknown[]): unknown => Reflect.apply(method, target, args)
    : undefined;
}

/**
 * Electron prefixes a rejected bridge call with "Error invoking remote method 'ace:…': Error: ";
 * the person needs only the reason after it.
 */
export function bridgeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, "").trim();
}

async function desktopStatus(scope: object): Promise<DesktopDaemonStatus | undefined> {
  try {
    return await desktopDaemon(scope)?.status();
  } catch {
    return undefined;
  }
}

function parseStatus(value: unknown): DesktopDaemonStatus | undefined {
  const status = record(value);
  if (!status || typeof status.state !== "string") return undefined;
  return {
    state: status.state,
    message: typeof status.message === "string" ? status.message : undefined,
  };
}

/**
 * The preload bridge's daemon calls. Fake mode exposes a debugging `ace` object too (the fake
 * daemon and client), so the bridge is recognised by its own shape: the platform it reports
 * and a `daemon.connection()` hand-off.
 */
function daemonBridge(scope: object): Record<string, unknown> | undefined {
  const ace = record(Reflect.get(scope, "ace"));
  if (typeof ace?.platform !== "string") return undefined;
  const daemon = record(ace.daemon);
  return typeof daemon?.connection === "function" ? daemon : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  // Read field by field, each checked before use.
  return value as Record<string, unknown>;
}
