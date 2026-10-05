import type { Frame } from "@ace/screen";
import type { DeviceSession } from "./session.ts";
import type { DeviceRuntime } from "./runtime.ts";
import type { DeviceStreamControl } from "./stream-control.ts";
/** Image consumers temporarily negotiate JPEG and restore every viewer's video preference. */
export async function deviceStreamSnapshot(
  session: DeviceSession,
  streams: DeviceStreamControl,
  runtime: DeviceRuntime,
): Promise<Frame> {
  const generation = session.generation;
  const pending = Promise.withResolvers<Frame>();
  void pending.promise.catch(() => {});
  const cancel = runtime.after(10000, () =>
    pending.reject(new Error("Device screenshot timed out")),
  );
  const release = session.hub.subscribe(async (frame) => {
    if (session.generation === generation && frame.header.codec === "jpeg") pending.resolve(frame);
  });
  const image = streams.acquireImage();
  try {
    await image.ready;
    return await pending.promise;
  } finally {
    release();
    cancel();
    await image.release();
  }
}
