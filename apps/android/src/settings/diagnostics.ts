/**
 * Redacted diagnostics export, ported from iOS `DiagnosticsReport`
 * (`Sources/Models/DiagnosticsReport.swift`) for M11/A15.05.
 *
 * Privacy contract: only codes and counts leave the phone. The input types
 * below expose no secret fields at all (no device tokens or tickets, no
 * device ids, no addresses or certificate pins, no thread titles or message
 * text), so a caller cannot accidentally submit a secret through this
 * module. `accessKind` carries only the pairing kind ("lan"/"tailscale"),
 * never the URL.
 */

export type DiagnosticsAccessKind = "lan" | "tailscale";

export interface DiagnosticsApp {
  readonly version: string;
  readonly build: string;
  readonly system: string;
  readonly device: string;
}

export interface DiagnosticsMachine {
  readonly name: string;
  readonly hostId: string;
  readonly accessKind?: DiagnosticsAccessKind;
  readonly connection: string;
  readonly problem?: string;
  readonly status?: string;
  readonly aceVersion?: string;
  readonly viewOnly: boolean;
  readonly threads: number;
  readonly unsent: number;
  readonly tools: Readonly<Record<string, string>>;
}

export interface DiagnosticsNotifications {
  readonly enabled: boolean;
  readonly permission: string;
  readonly mutedMachines: number;
}

export interface DiagnosticsLock {
  readonly enabled: boolean;
  readonly timeoutSeconds: number;
}

export interface DiagnosticsReport {
  readonly generatedAt: string;
  readonly app: DiagnosticsApp;
  readonly machines: ReadonlyArray<DiagnosticsMachine>;
  readonly notifications?: DiagnosticsNotifications;
  readonly lock?: DiagnosticsLock;
}

export function parseDiagnosticsAccessKind(value: unknown): DiagnosticsAccessKind | undefined {
  return value === "lan" || value === "tailscale" ? value : undefined;
}

export function collectDiagnosticsReport(args: {
  generatedAt: string;
  app: DiagnosticsApp;
  machines: ReadonlyArray<DiagnosticsMachine>;
  notifications?: DiagnosticsNotifications;
  lock?: DiagnosticsLock;
}): DiagnosticsReport {
  return {
    generatedAt: args.generatedAt,
    app: { ...args.app },
    machines: args.machines.map((machine) => ({
      ...machine,
      tools: { ...machine.tools },
    })),
    ...(args.notifications ? { notifications: { ...args.notifications } } : {}),
    ...(args.lock ? { lock: { ...args.lock } } : {}),
  };
}

/** Deterministic pretty JSON with sorted keys, mirroring the iOS encoder. */
export function renderDiagnosticsJson(report: DiagnosticsReport): string {
  return `${JSON.stringify(sortKeys(report), null, 2)}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
