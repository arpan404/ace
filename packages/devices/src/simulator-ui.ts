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
import { catalogRefusal } from "./sdk.ts";
import { nativeAxLimits, nativeInput } from "./native-input.ts";
import {
  simulatorActionInput,
  simulatorLayout,
  simulatorTarget,
  simulatorTree,
} from "./simulator-ax.ts";

/** Accessibility reads and semantic actions a live capture serves itself. */
export interface CaptureUI {
  tree(options: unknown): Promise<ScreenUITreeResult>;
  find(options: unknown): Promise<ScreenUIFindResult>;
  act(options: unknown, guard: () => void): Promise<z.infer<typeof ScreenUIActResult>>;
}

/** The read's body cap and deadline: ace-devices' numbers, with today's as the default. */
const axLimits = nativeInput ? nativeAxLimits() : { bodyBytes: 4 * 1024 * 1024, timeoutMs: 10_000 };

/** serve-sim's in-process accessibility bridge, read on demand from its `/ax` route. */
export function simulatorUI(options: {
  url: URL;
  fetch: typeof fetch;
  signal: AbortSignal;
  after(ms: number, run: () => void): () => void;
  screen(): { width: number; height: number; orientation?: string };
  input(input: DeviceInput, guard: () => void): Promise<void>;
}): CaptureUI {
  const read = async (limits: unknown) => {
    const { width, height, orientation } = options.screen();
    if (!width || !height) throw catalogRefusal("simulatorSizeUnknown");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const cancel = options.after(axLimits.timeoutMs, abort);
    try {
      const response = await options.fetch(options.url, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok || !response.body) throw catalogRefusal("simulatorAxUnavailable");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > axLimits.bodyBytes) throw catalogRefusal("simulatorAxBudget");
        chunks.push(Buffer.from(chunk));
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw catalogRefusal("simulatorTreeUnreadable");
      }
      const screen = { width, height, ...(orientation ? { orientation } : {}) };
      return { tree: simulatorTree(raw, screen, limits), turn: simulatorLayout(raw, screen).turn };
    } catch (error) {
      if (controller.signal.aborted && !options.signal.aborted)
        throw catalogRefusal("simulatorAxTimeout");
      throw error;
    } finally {
      cancel();
      options.signal.removeEventListener("abort", abort);
    }
  };
  return {
    tree: async (limits) => (await read(limits)).tree,
    async find(raw) {
      const query = ScreenUIFindOptions.parse(raw);
      return androidFind((await read({ maxNodes: 512, maxDepth: 16 })).tree, query);
    },
    async act(raw, guard) {
      const action = ScreenUIActOptions.parse(raw);
      const { tree, turn } = await read({ maxNodes: 512, maxDepth: 16 });
      const input = simulatorActionInput(simulatorTarget(tree, action.ref), action, turn);
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
