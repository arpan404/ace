import { availableParallelism, loadavg } from "node:os";
import { z } from "zod";
import {
  analyzeInteraction,
  aggregateMeasurements,
  validateMeasurementBudget,
} from "@ace/interaction";
import { BrowserMeasurementOptions, type InteractionMeasurement } from "@ace/protocol";
import type { BrowserBackendSession } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";
import { MeasurementTrace } from "./measurement-trace.ts";
import { MeasurementFrames, measurementFilmstrip } from "./measurement-filmstrip.ts";
import { BrowserActionError } from "./action-error.ts";

interface MeasurementContext {
  threadId: string;
  backend: BrowserBackendSession;
  clock: NavigationClock;
  id(): string;
  read(): void;
  input(
    interaction: NonNullable<import("@ace/protocol").BrowserMeasurementOptions["interaction"]>,
    signal: AbortSignal | undefined,
    beforeInput: () => void,
  ): Promise<unknown>;
  host?(): { hostLoad: number; cores: number };
}
function wait(clock: NavigationClock, ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      cancel();
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const cancel = clock.set(ms, () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}
const Frame = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const World = z.object({ executionContextId: z.number().int() });
/** Trace timestamps and the isolated-world TimeStamp marker share Chromium's monotonic clock.
 * Existing screencast JPEGs are illustrative only; compositor DrawFrame events own timing. */
async function runMeasurement(
  options: BrowserMeasurementOptions,
  context: MeasurementContext,
  signal?: AbortSignal,
): Promise<InteractionMeasurement> {
  const { backend, clock } = context,
    cdp = backend.cdp;
  signal?.throwIfAborted();
  context.read();
  const marker = `ace-measure-${context.id()}`;
  const trace = new MeasurementTrace(marker),
    frames = new MeasurementFrames(options.observeMs, () => clock.now());
  let processingMs = 0,
    started = false;
  const collect = (raw: unknown) => {
    const start = clock.now();
    trace.accept(raw);
    processingMs += Math.max(0, clock.now() - start);
  };
  const capture = (raw: unknown) => {
    try {
      context.read();
      frames.accept(raw);
    } catch {
      /* A private takeover discards pixels immediately. */
    }
  };
  const completed = Promise.withResolvers<void>();
  const complete = (raw: unknown) => {
    const result = z.object({ dataLossOccurred: z.boolean().optional() }).safeParse(raw);
    if (result.success && result.data.dataLossOccurred) trace.truncated = true;
    completed.resolve();
  };
  cdp.on("Tracing.dataCollected", collect);
  cdp.on("Tracing.tracingComplete", complete);
  if (options.filmstrip) cdp.on("Page.screencastFrame", capture);
  try {
    const frameId = Frame.parse(await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    const world = World.parse(
      await cdp.send("Page.createIsolatedWorld", {
        frameId,
        worldName: "ace-interaction-measurement",
      }),
    );
    if (options.filmstrip) {
      frames.seed(Buffer.from(await backend.screenshot("jpeg")));
      context.read();
    }
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordUntilFull",
        traceBufferSizeInKb: 4096,
        includedCategories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
        ],
      },
    });
    started = true;
    context.read();
    signal?.throwIfAborted();
    // The marker's host zero precedes its CDP round trip. Using a later reply time
    // would allow pre-input compositor frames to masquerade as an input response.
    const startedAt = clock.now();
    const window = wait(clock, options.observeMs, signal);
    const ended = window.then(
      async () => {
        if (started) {
          started = false;
          await cdp.send("Tracing.end");
        }
      },
      () => {},
    );
    void ended.catch(() => {});
    await cdp.send("Runtime.evaluate", {
      expression: `console.timeStamp(${JSON.stringify(marker)})`,
      contextId: world.executionContextId,
      returnByValue: true,
      timeout: 1000,
    });
    frames.begin(startedAt);
    const injection = new AbortController();
    const inputSignal = signal ? AbortSignal.any([signal, injection.signal]) : injection.signal;
    let actionAtMs: number | undefined;
    let inputPending = false;
    const input = options.interaction
      ? context.input(options.interaction, inputSignal, () => {
          const offset = Math.max(0, clock.now() - startedAt);
          if (offset >= options.observeMs)
            throw new BrowserActionError(
              "timeout",
              "Input was not ready within the recording window",
            );
          actionAtMs ??= offset;
        })
      : undefined;
    if (input) {
      inputPending = true;
      void input.then(
        () => {
          inputPending = false;
        },
        () => {
          inputPending = false;
        },
      );
    }
    try {
      if (input) await Promise.race([input, window]);
      await window;
    } finally {
      // Keep the session queue until dispatched input settles. Abort stops drag's later steps.
      if (inputPending) injection.abort(new Error("Measurement recording window ended"));
      if (input) await input;
    }
    await ended;
    await Promise.race([
      completed.promise,
      wait(clock, 2000, signal).then(() => {
        throw new BrowserActionError("timeout", "Browser trace did not finish");
      }),
    ]);
    context.read();
    signal?.throwIfAborted();
    const evidence = trace.result(options.observeMs);
    const host = context.host?.() ?? { hostLoad: loadavg()[0] ?? 0, cores: availableParallelism() };
    const measurement = analyzeInteraction({
      source: "browser-trace",
      target: {
        kind: "browser-tab",
        threadId: context.threadId,
        tabId: backend.tabs?.active() ?? frameId,
      },
      ...(options.interaction
        ? { action: options.interaction, ...(actionAtMs === undefined ? {} : { actionAtMs }) }
        : {}),
      refreshHz: evidence.refreshHz,
      windowMs: options.observeMs,
      updatesMs: evidence.updatesMs,
      longTasks: evidence.longTasks,
      layoutShift: evidence.layoutShift,
      ...host,
      captureOverheadPct: (processingMs / options.observeMs) * 100,
      truncated: evidence.truncated,
      refreshAssumed: evidence.inferredRefresh,
      notes: [
        "Refresh rate is inferred from Chromium BeginFrame cadence; headless cadence may be virtual.",
        "Long tasks include all work on the target renderer main thread, including shared-renderer tab contention.",
        "Input time conservatively includes the marker CDP round trip; early responses may be skipped and timing retains clock uncertainty.",
        "Capture overhead measures host trace processing, excluding Chromium tracing, existing screencast and post-window filmstrip encoding.",
        ...(options.filmstrip
          ? [
              "Filmstrip reuses the bounded live screencast; its cadence does not measure frame timing.",
            ]
          : []),
        ...(evidence.inferredRefresh ? ["No display cadence found; assumed 60 Hz."] : []),
      ],
    });
    if (evidence.inferredRefresh) measurement.confidence = "low";
    if (options.filmstrip) {
      const filmstrip = await measurementFilmstrip(
        frames
          .candidates()
          .map((candidate) => ({ data: candidate.data, atMs: candidate.atMs - (actionAtMs ?? 0) })),
        measurement,
      );
      context.read();
      signal?.throwIfAborted();
      if (filmstrip) measurement.filmstrip = filmstrip;
      else measurement.notes.push("No filmstrip image was available within the image bound.");
    }
    return measurement;
  } finally {
    cdp.off("Tracing.dataCollected", collect);
    cdp.off("Tracing.tracingComplete", complete);
    if (options.filmstrip) cdp.off("Page.screencastFrame", capture);
    if (started) {
      started = false;
      await cdp.send("Tracing.end").catch(() => {});
    }
  }
}
export async function measureBrowserInteraction(
  raw: unknown,
  context: MeasurementContext,
  signal?: AbortSignal,
): Promise<InteractionMeasurement> {
  const options = BrowserMeasurementOptions.parse(raw);
  validateMeasurementBudget(options);
  const runs: InteractionMeasurement[] = [];
  for (let run = 0; run < options.repeat; run++) {
    context.read();
    signal?.throwIfAborted();
    runs.push(await runMeasurement(options, context, signal));
  }
  return aggregateMeasurements(runs);
}
