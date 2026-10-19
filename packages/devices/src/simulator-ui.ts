import {
  ScreenUIActOptions,
  ScreenUIFindOptions,
  type ScreenUIActResult,
  type ScreenUIFindResult,
  type ScreenUITreeResult,
} from "@ace/protocol";
import type { DeviceInput } from "@ace/protocol/devices";
import type { z } from "zod";
import { androidFind } from "./android-ui.ts";
import { DeviceError } from "./sdk.ts";
import { simulatorActionInput, simulatorTarget, simulatorTree } from "./simulator-ax.ts";

/** Accessibility reads and semantic actions a live capture serves itself. */
export interface CaptureUI {
  tree(options: unknown): Promise<ScreenUITreeResult>;
  find(options: unknown): Promise<ScreenUIFindResult>;
  act(options: unknown, guard: () => void): Promise<z.infer<typeof ScreenUIActResult>>;
}

const bodyLimit = 4 * 1024 * 1024;

/** serve-sim's in-process accessibility bridge, read on demand from its `/ax` route. */
export function simulatorUI(options: {
  url: URL;
  fetch: typeof fetch;
  signal: AbortSignal;
  after(ms: number, run: () => void): () => void;
  screen(): { width: number; height: number };
  input(input: DeviceInput, guard: () => void): Promise<void>;
}): CaptureUI {
  const read = async (limits: unknown) => {
    const { width, height } = options.screen();
    if (!width || !height)
      throw new DeviceError(
        "not_found",
        "Simulator screen size is not known yet",
        "Wait for the live view's first frame, then read the tree again.",
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const cancel = options.after(10000, abort);
    try {
      const response = await options.fetch(options.url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new DeviceError(
          "command_failed",
          "Simulator accessibility is unavailable",
          "Unlock the Simulator and wait for an app to be frontmost, then read the tree again.",
        );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > bodyLimit)
          throw new DeviceError(
            "limit",
            "Simulator accessibility tree exceeds its budget",
            "Reduce the app's UI tree.",
          );
        chunks.push(Buffer.from(chunk));
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new DeviceError(
          "invalid_data",
          "Simulator accessibility tree is malformed",
          "Read the UI tree again.",
        );
      }
      return simulatorTree(raw, { width, height }, limits);
    } catch (error) {
      if (controller.signal.aborted && !options.signal.aborted)
        throw new DeviceError(
          "timeout",
          "Simulator accessibility read timed out",
          "Read the UI tree again.",
        );
      throw error;
    } finally {
      cancel();
      options.signal.removeEventListener("abort", abort);
    }
  };
  return {
    tree: read,
    async find(raw) {
      const query = ScreenUIFindOptions.parse(raw);
      return androidFind(await read({ maxNodes: 512, maxDepth: 16 }), query);
    },
    async act(raw, guard) {
      const action = ScreenUIActOptions.parse(raw);
      const node = simulatorTarget(await read({ maxNodes: 512, maxDepth: 16 }), action.ref);
      const input = simulatorActionInput(node, action);
      if (input.kind === "none") return { fallback: false, method: input.method };
      guard();
      await options.input(input, guard);
      return {
        fallback: true,
        method: "serve-sim.hid",
        boundsCentre: { x: input.x, y: input.y },
      };
    },
  };
}
