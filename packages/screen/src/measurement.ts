import { z } from "zod";
import {
  InteractionEvidence,
  ScreenMeasurementOptions,
  type InteractionMeasurement,
} from "@ace/protocol";
import {
  analyzeInteraction,
  aggregateMeasurements,
  validateMeasurementBudget,
} from "@ace/interaction";
import { HelperCommandError } from "./helper.ts";
import type { Session } from "./session.ts";
const NativeEvidence = InteractionEvidence.omit({
  source: true,
  target: true,
  action: true,
}).extend({ hostCores: z.number().int().positive().optional() });
/** Native capture uses a separate bounded high-rate stream. A pixel lease keeps the existing
 * capture indicator on throughout startup, measurement and native cleanup. */
export async function measureSession(
  session: Session,
  raw: unknown,
  validate: () => void,
): Promise<InteractionMeasurement> {
  const options = ScreenMeasurementOptions.parse(raw);
  validateMeasurementBudget(options);
  if (session.state.target.kind !== "window" || session.helper.capabilities?.platform !== "macos")
    throw new HelperCommandError(
      "not_supported",
      "Interaction measurement requires a macOS window",
    );
  const lease = session.pixels.acquire();
  try {
    await lease.ready;
    const runs: InteractionMeasurement[] = [];
    let recordedMs = 0;
    for (let run = 0; run < options.repeat; run++) {
      validate();
      const maxWindowMs = Math.min(10_000, Math.floor(20_000 - recordedMs));
      if (maxWindowMs < 1) break;
      const result = NativeEvidence.parse(
        await session.helper.request(
          {
            op: "measure_interaction",
            observeMs: options.observeMs,
            filmstrip: options.filmstrip,
            maxWindowMs,
            ...(options.action ? { action: options.action } : {}),
          },
          validate,
        ),
      );
      validate();
      if (result.windowMs > maxWindowMs)
        throw new Error("Native measurement exceeded its remaining recording budget");
      recordedMs += result.windowMs;
      const { hostCores, ...evidence } = result;
      runs.push(
        analyzeInteraction({
          ...evidence,
          source: "screen-frames",
          target: session.state.target,
          ...(options.action ? { action: options.action } : {}),
          ...(hostCores ? { cores: hostCores } : {}),
        }),
      );
    }
    const measurement = aggregateMeasurements(runs);
    if (runs.length < options.repeat) {
      measurement.verdict = "inconclusive";
      measurement.confidence = "low";
      measurement.notes.push(
        `Recording budget ended after ${runs.length} of ${options.repeat} requested runs.`,
      );
    }
    return measurement;
  } finally {
    lease.release();
    await session.pixels.settle();
  }
}
