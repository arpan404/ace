import type { DiagnosticEvent } from "@ace/client";

/*
 * Where the client's connection facts go: the desktop app's log through its preload bridge
 * (`window.ace.diagnostics.report`), else the console. Feature-checked at the call, so a page
 * without the bridge (a plain browser, an older desktop build) still runs.
 */

interface DiagnosticsBridge {
  report(event: DiagnosticEvent): void;
}

const hasReport = (value: unknown): value is DiagnosticsBridge =>
  typeof value === "object" &&
  value !== null &&
  "report" in value &&
  typeof value.report === "function";

function bridge(scope: unknown): DiagnosticsBridge | undefined {
  if (typeof scope !== "object" || scope === null || !("ace" in scope)) return undefined;
  const ace = scope.ace;
  if (typeof ace !== "object" || ace === null || !("diagnostics" in ace)) return undefined;
  return hasReport(ace.diagnostics) ? ace.diagnostics : undefined;
}

/** A reporter for `scope` (the page's global): the desktop bridge if it has one, else `warn`. */
export function diagnosticsReporter(
  scope: unknown = globalThis,
  warn: (message: string, data?: unknown) => void = (message, data) =>
    console.warn(message, data ?? ""),
): (event: DiagnosticEvent) => void {
  return (event) => {
    const desktop = bridge(scope);
    if (desktop) {
      try {
        desktop.report(event);
        return;
      } catch {
        /* The bridge is broken: fall back to the console. */
      }
    }
    warn(`ace: ${event.event}`, event.data);
  };
}
