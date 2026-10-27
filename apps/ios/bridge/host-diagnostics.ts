import { downloadFile, type ClientCore } from "@ace/client";
import { SettingsValues, type DiagnosticReport, type DiagnosticsHealth } from "@ace/protocol";
import {
  checkStatusWords,
  healthRows,
  hostChecks,
  queueRows,
  unknownCheck,
} from "@ace/ui-core/host-care";
import { z } from "zod";
import { base64, gather } from "./bytes.ts";
import { host } from "./host.ts";
import { HostProblem } from "./host-problem.ts";

/*
 * One machine's Diagnostics page: read-only setup checks, the daemon's health, a support bundle
 * the phone shares with the share sheet, the worktree preparation deadline and a reset of the
 * machine's settings. `ace triage` and `ace doctor`'s repairs stay on the computer (ADR 0092).
 */

const msPerMinute = 60_000;
/** The support bundle's cap, as the web's export. */
const bundleLimit = 16 * 1024 ** 2;
/** Longer than the daemon's largest integrity budget, so the daemon reports first. */
const checksTimeoutMs = 16 * 60_000;

export const HostDiagnosticsRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.diagnostics") }),
  z.object({ type: z.literal("host.checks") }),
  z.object({ type: z.literal("host.support"), includeThreads: z.boolean() }),
  z.object({ type: z.literal("host.worktreeTimeout"), minutes: z.number() }),
  z.object({ type: z.literal("host.reset") }),
]);
export type HostDiagnosticsRequest = z.infer<typeof HostDiagnosticsRequest>;

export interface HostCheckRow {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  word: string;
  message: string;
  /** What to do, for a check that didn't pass. */
  fix: string | null;
}

/** The setup checks as rows, without the provider checks Providers already shows. */
export function checkRows(report: DiagnosticReport): HostCheckRow[] {
  return report.checks
    .filter((check) => !check.id.startsWith("provider."))
    .map((check) => {
      const info = hostChecks[check.id] ?? unknownCheck;
      return {
        id: check.id,
        label: info.label,
        status: check.status,
        word: checkStatusWords[check.status],
        message: check.message,
        fix: check.status === "ok" ? null : info.fix,
      };
    });
}

/** One line over the checks: all passed, or how many need something. */
export function checksSummary(rows: readonly HostCheckRow[]): string {
  const failing = rows.filter((row) => row.status !== "ok").length;
  if (!failing) return "Every check passed.";
  return failing === 1 ? "1 check needs attention." : `${failing} checks need attention.`;
}

export function healthView(health: DiagnosticsHealth) {
  return {
    rows: healthRows(health).map(([label, value]) => ({ label, value })),
    queues: queueRows(health),
    /** The report as JSON for a bug report, as the web's Copy diagnostics. */
    json: JSON.stringify(health, null, 2),
  };
}

export class HostDiagnostics {
  #owner: ClientCore;
  constructor(owner: ClientCore) {
    this.#owner = owner;
  }
  async answer(request: HostDiagnosticsRequest, signal: AbortSignal): Promise<unknown> {
    switch (request.type) {
      case "host.diagnostics":
        return this.#page(signal);
      case "host.checks": {
        const reply = await this.#owner.request(
          { type: "diagnostics.request", operation: "doctor", requestId: host.uuid() },
          { signal, timeoutMs: checksTimeoutMs },
        );
        if (!reply.report || reply.error)
          throw new HostProblem(
            reply.error === "diagnostics_busy"
              ? "Checks are already running on this machine. Try again shortly."
              : "Couldn't finish the checks. Reconnect to this computer and try again.",
          );
        const rows = checkRows(reply.report);
        return { type: "host.checks", summary: checksSummary(rows), rows };
      }
      case "host.support":
        return this.#support(request.includeThreads, signal);
      case "host.worktreeTimeout": {
        const parsed = SettingsValues.shape["worktree.preparationTimeoutMs"].safeParse(
          Math.round(request.minutes * msPerMinute),
        );
        if (!parsed.success) throw new HostProblem("Use 1 to 60 minutes.");
        const reply = await this.#owner.request(
          {
            type: "settings.set",
            key: "worktree.preparationTimeoutMs",
            value: parsed.data,
            layer: { kind: "global" },
            requestId: host.uuid(),
          },
          { signal, timeoutMs: 15_000 },
        );
        if (!reply.ok) throw new HostProblem("Couldn't save that setting.");
        return this.#page(signal);
      }
      case "host.reset": {
        const reply = await this.#owner.request(
          { type: "settings.reset", requestId: host.uuid() },
          { signal, timeoutMs: 15_000 },
        );
        if (!reply.ok) throw new HostProblem("This machine couldn't save the reset. Try again.");
        return this.#page(signal);
      }
    }
  }
  async #page(signal: AbortSignal) {
    const [health, timeout] = await Promise.allSettled([
      this.#owner.request(
        { type: "diagnostics.health", requestId: host.uuid() },
        { signal, timeoutMs: 10_000 },
      ),
      this.#owner.request(
        {
          type: "settings.get",
          key: "worktree.preparationTimeoutMs",
          scope: {},
          requestId: host.uuid(),
        },
        { signal, timeoutMs: 15_000 },
      ),
    ]);
    const report = health.status === "fulfilled" && health.value.ok ? health.value.health : null;
    const entry =
      timeout.status === "fulfilled" && timeout.value.ok
        ? timeout.value.entries.find((item) => item.key === "worktree.preparationTimeoutMs")
        : undefined;
    const ms = SettingsValues.shape["worktree.preparationTimeoutMs"].safeParse(entry?.value);
    return {
      type: "host.diagnostics",
      health: report ? healthView(report) : null,
      healthProblem: report ? null : "Couldn't read ace health. Pull to try again.",
      worktreeTimeout: ms.success
        ? {
            minutes: Math.round(ms.data / msPerMinute),
            pinnedBy:
              entry?.provenance === "environment" ? "ACE_WORKTREE_PREPARATION_TIMEOUT_MS" : null,
          }
        : null,
    };
  }
  async #support(includeThreads: boolean, signal: AbortSignal) {
    const failed = includeThreads
      ? "Couldn't export conversations. Use ace on this computer, or turn off Include conversations and try again."
      : "Couldn't export the support bundle. Reconnect to this computer and try again.";
    try {
      const made = await this.#owner.request(
        {
          type: "files.request",
          scope: "support",
          operation: { op: "artifact.support", includeThreads },
          requestId: host.uuid(),
        },
        { signal, timeoutMs: 60_000 },
      );
      const artifact = z
        .object({ artifactId: z.string().min(1).max(128) })
        .parse(made.type === "files.result" ? made.value : undefined);
      const read = await gather(
        downloadFile(
          this.#owner,
          {
            scope: "support",
            op: "artifact.download",
            artifactId: artifact.artifactId,
            offset: 0,
          },
          { signal },
        ),
        bundleLimit,
      );
      if (!("bytes" in read)) throw new Error("Support bundle too large");
      return {
        type: "host.support",
        name: "ace-support.tar.gz",
        data: base64(read.bytes),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HostProblem(failed);
    }
  }
}
