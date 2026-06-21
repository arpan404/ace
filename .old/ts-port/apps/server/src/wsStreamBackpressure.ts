import { Effect, Stream } from "effect";

const DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY = 1_024;
const DROP_REPORT_GROWTH_STEP = 500;

interface LiveUiStreamLagState {
  ingressCount: number;
  egressCount: number;
  reportedDroppedAtLeast: number;
}

interface BufferLiveUiStreamOptions {
  readonly capacity?: number;
  readonly label?: string;
}

function normalizeLiveUiStreamBufferCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) {
    return DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY;
  }
  return Math.max(1, Math.floor(capacity));
}

function recordLiveUiStreamIngress(state: LiveUiStreamLagState, capacity: number): number | null {
  state.ingressCount += 1;
  const droppedAtLeast = state.ingressCount - state.egressCount - capacity;
  if (droppedAtLeast <= 0) {
    return null;
  }
  if (
    state.reportedDroppedAtLeast > 0 &&
    droppedAtLeast - state.reportedDroppedAtLeast < DROP_REPORT_GROWTH_STEP
  ) {
    return null;
  }
  state.reportedDroppedAtLeast = droppedAtLeast;
  return droppedAtLeast;
}

export function bufferLiveUiStream<A, E, R>(
  stream: Stream.Stream<A, E, R>,
  options: BufferLiveUiStreamOptions = {},
): Stream.Stream<A, E, R> {
  const capacity = normalizeLiveUiStreamBufferCapacity(
    options.capacity ?? DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY,
  );
  const label = options.label ?? "live-ui-stream";
  return Stream.unwrap(
    Effect.sync(() => {
      const lagState: LiveUiStreamLagState = {
        ingressCount: 0,
        egressCount: 0,
        reportedDroppedAtLeast: 0,
      };
      return stream.pipe(
        Stream.tap(() => {
          const droppedAtLeast = recordLiveUiStreamIngress(lagState, capacity);
          if (droppedAtLeast === null) {
            return Effect.void;
          }
          return Effect.logWarning(
            `[ws-stream] slow "${label}" subscriber: dropped at least ${String(
              droppedAtLeast,
            )} oldest events (capacity=${String(capacity)})`,
          );
        }),
        Stream.buffer({ capacity, strategy: "sliding" }),
        Stream.tap(() =>
          Effect.sync(() => {
            lagState.egressCount += 1;
          }),
        ),
      );
    }),
  );
}
