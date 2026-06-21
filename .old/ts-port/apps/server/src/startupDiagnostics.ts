import { Effect, Exit } from "effect";

const startupOriginMs = typeof performance !== "undefined" ? performance.now() : Date.now();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundMs(value: number): number {
  return Number(value.toFixed(1));
}

export function startupElapsedMs(): number {
  return roundMs(nowMs() - startupOriginMs);
}

export function logStartupEvent(input: {
  readonly phase: string;
  readonly message: string;
  readonly level?: "debug" | "info" | "warning" | "error";
  readonly detail?: Record<string, unknown>;
}) {
  const message = `[ace:start] [${input.phase}] ${input.message}`;
  const detail = input.detail;

  switch (input.level) {
    case "debug":
      return Effect.logDebug(message, detail);
    case "warning":
      return Effect.logWarning(message, detail);
    case "error":
      return Effect.logError(message, detail);
    default:
      return Effect.logInfo(message, detail);
  }
}

export function withStartupTiming<A, E, R>(
  phase: string,
  label: string,
  effect: Effect.Effect<A, E, R>,
  options?: {
    readonly startDetail?: Record<string, unknown>;
    readonly endDetail?: (value: A) => Record<string, unknown> | undefined;
  },
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const startDetail = options?.startDetail;
    yield* logStartupEvent({
      phase,
      message: `${label} started`,
      ...(startDetail ? { detail: startDetail } : {}),
    });
    const exit = yield* Effect.exit(effect);

    if (Exit.isSuccess(exit)) {
      const endDetail = options?.endDetail?.(exit.value);
      yield* logStartupEvent({
        phase,
        message: `${label} finished`,
        ...(endDetail ? { detail: endDetail } : {}),
      });
      return exit.value;
    }

    yield* logStartupEvent({
      phase,
      level: "error",
      message: `${label} failed`,
      detail: {
        cause: exit.cause,
      },
    });
    return yield* Effect.failCause(exit.cause);
  });
}
