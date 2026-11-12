import { z } from "zod";
import type { ClientCore } from "@ace/client";
import type { Toolchain } from "@ace/protocol";
import { simulatorToolIds, toolchainRow, toolWords, type ToolchainRow } from "@ace/ui-core";
import { host } from "./host.ts";

/*
 * The tools a machine's simulators and emulators need, for the phone's Settings › Simulators:
 * Xcode, ace's simulator streaming and the Android SDK, each Ready or Not installed with how to
 * get it, as the web's Simulators page lists them. Words come from `@ace/ui-core`. A missing
 * simulator streaming is ace's own to download, through the machine's devices channel
 * (`tools.install`).
 */

export const SimulatorToolsRequest = z.object({ type: z.literal("simulators.tools") });

export interface SimulatorToolRow extends ToolchainRow {
  /** Offered when ace can get the tool itself; null when it can't or there's nothing to get. */
  download: { label: string; working: string; failed: string } | null;
}

export interface SimulatorTools {
  type: "simulators.tools";
  rows: SimulatorToolRow[];
  /** Why there are no rows; null when the machine answered. */
  problem: string | null;
  /** The action that reads them again. */
  checkAgain: string;
}

/** The machine's reported tools as the page's rows, in its order. Pure. */
export function simulatorToolRows(tools: readonly Toolchain[]): SimulatorToolRow[] {
  return simulatorToolIds.flatMap((id) => {
    const tool = tools.find((entry) => entry.id === id);
    if (!tool) return [];
    const row = toolchainRow(tool);
    const download =
      !row.ready && id === "serve-sim"
        ? {
            label: toolWords.download,
            working: toolWords.downloading,
            failed: toolWords.downloadFailed,
          }
        : null;
    return [{ ...row, download }];
  });
}

export async function readSimulatorTools(
  owner: ClientCore,
  signal: AbortSignal,
): Promise<SimulatorTools> {
  const checkAgain = toolWords.checkAgain;
  const failed: SimulatorTools = {
    type: "simulators.tools",
    rows: [],
    problem: toolWords.problem,
    checkAgain,
  };
  try {
    const reply = await owner.request(
      { type: "diagnostics.request", operation: "toolchains", requestId: host.uuid() },
      { signal, timeoutMs: 20_000 },
    );
    if (!reply.toolchains || reply.error) return failed;
    return {
      type: "simulators.tools",
      rows: simulatorToolRows(reply.toolchains),
      problem: null,
      checkAgain,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return failed;
  }
}
