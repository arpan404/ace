import { StreamMeter, streamDetails, streamSummary } from "@ace/ui-core/devices";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

/*
 * A device's live stream stats on the phone, worded as the web words them (`@ace/ui-core`'s
 * `StreamMeter`). Pictures never enter JavaScript: Swift counts them as they arrive and are
 * drawn, and hands over a batch about once a second while the stats show. The phone's and the
 * daemon's clocks are different machines', so no capture-to-screen delay is claimed.
 */

const time = z.number().finite().nonnegative();
export const DeviceStatsControl = z.object({
  type: z.literal("native.devices.stats"),
  deviceId: z.string().min(1).max(256),
  /** Stop: the stats were hidden or the device closed. */
  stop: z.boolean().optional(),
  now: time,
  /** Each picture drawn since the last batch: when it was captured and when it was shown. */
  drawn: z
    .array(z.tuple([time, time]))
    .max(600)
    .default([]),
  /** Each picture that arrived: when and how many bytes. */
  received: z
    .array(z.tuple([time, z.number().int().nonnegative()]))
    .max(600)
    .default([]),
  /** When the decoder asked for a keyframe. */
  keyframes: z.array(time).max(600).default([]),
  /** The decoder runs on the phone's hardware (VideoToolbox). */
  hardware: z.boolean().default(true),
});
export type DeviceStatsControl = z.infer<typeof DeviceStatsControl>;

export class DeviceStats {
  #meters = new Map<string, StreamMeter>();
  #sink: PatchSink;
  constructor(sink: PatchSink) {
    this.#sink = sink;
  }
  handle(batch: DeviceStatsControl): void {
    const key = `devices:stats:${batch.deviceId}`;
    if (batch.stop) {
      this.#meters.delete(batch.deviceId);
      this.#sink.clear(key);
      return;
    }
    let meter = this.#meters.get(batch.deviceId);
    if (!meter) {
      meter = new StreamMeter({ sameClock: false });
      this.#meters.set(batch.deviceId, meter);
    }
    meter.decoder(batch.hardware ? "hardware" : "default");
    for (const [at, bytes] of batch.received) meter.receive(at, bytes);
    for (const [capturedAt, shownAt] of batch.drawn) meter.add({ capturedAt, shownAt });
    for (const at of batch.keyframes) meter.keyframeAsked(at);
    const stats = meter.read(batch.now);
    this.#sink.put(key, () => ({
      type: "devices.stats",
      deviceId: batch.deviceId,
      summary: streamSummary(stats).join(" · "),
      // The phone decodes with VideoToolbox, which says where it ran.
      details: streamDetails(stats).map((line) =>
        line === "Decoder: hardware asked for (unconfirmed)"
          ? "Decoder: hardware (VideoToolbox)"
          : line,
      ),
    }));
  }
}
