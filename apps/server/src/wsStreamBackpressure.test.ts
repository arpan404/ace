import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { collectRuntimeProfileSnapshot } from "./runtimeProfile";
import { bufferLiveUiStream } from "./wsStreamBackpressure";

describe("bufferLiveUiStream", () => {
  it("terminates overflowing slow subscribers instead of silently dropping old events", async () => {
    const before = collectRuntimeProfileSnapshot();

    await expect(
      Effect.runPromise(
        bufferLiveUiStream(Stream.fromIterable(Array.from({ length: 100 }, (_, index) => index)), {
          capacity: 1,
          label: "test-overflow",
        }).pipe(
          Stream.tap(() => Effect.sleep("10 millis")),
          Stream.runDrain,
        ),
      ),
    ).rejects.toThrow(/overflowed/);

    const after = collectRuntimeProfileSnapshot();
    expect(after.liveStreams.overflowCount).toBeGreaterThan(before.liveStreams.overflowCount);
    expect(after.liveStreams.droppedEventCount).toBeGreaterThan(
      before.liveStreams.droppedEventCount,
    );
  });
});
