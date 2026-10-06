/// <reference lib="dom" />
import type { ScreenFrameHeader, ScreenStreamSettings } from "@ace/protocol";
import type { PortableFrame } from "@ace/screen/frames-client";

const even = (value: number) => Math.max(64, Math.ceil(value / 2) * 2);
export type DeviceConnection = "local" | "remote" | "relay";
/** Panel dimensions are physical pixels. Preserve aspect ratio in the native capture. */
export function deviceStreamProfile(
  panel: { width: number; height: number },
  connection: DeviceConnection,
  video: boolean,
  pressure = 0,
): ScreenStreamSettings {
  const limits =
    connection === "local"
      ? [3840, 3840, 60, 12000000]
      : connection === "remote"
        ? [1080, 1440, 30, 2500000]
        : [720, 1280, 30, 1200000];
  const factor = 1 / (1 + Math.max(0, Math.min(3, pressure)) * 0.5);
  return {
    codec: video ? "h264" : "jpeg",
    maxWidth: even(
      Math.min(panel.width, limits[0] ?? 3840) * (connection === "local" ? 1 : factor),
    ),
    maxHeight: even(
      Math.min(panel.height, limits[1] ?? 2160) * (connection === "local" ? 1 : factor),
    ),
    fps: pressure ? 30 : (limits[2] ?? 30),
    bitrate: Math.max(128000, Math.round((limits[3] ?? 2500000) * factor * factor)),
  };
}

export interface DeviceDecoder {
  readonly decodeQueueSize: number;
  decode(frame: PortableFrame): void;
  close(): void;
}
export interface DecodedDeviceFrame {
  close(): void;
}
export interface DeviceRendererPorts {
  decoder(
    header: ScreenFrameHeader,
    output: (image: DecodedDeviceFrame) => void,
    error: (reason?: "unsupported" | "decode") => void,
  ): DeviceDecoder;
  video(image: DecodedDeviceFrame, header: ScreenFrameHeader): void;
  image(frame: PortableFrame): Promise<void>;
  keyframe(): void;
  fallback(): void;
  pressure(): void;
  schedule(run: () => void, ms: number): () => void;
}
/** Every dropped interframe invalidates its dependants. Resume only at a self-contained IDR. */
export function createDeviceRenderer(ports: DeviceRendererPorts) {
  let decoder: DeviceDecoder | undefined;
  let previous = -1;
  let stream = "";
  let width = 0,
    height = 0,
    codec = "";
  let waiting = true;
  let requested = false;
  let failed = false;
  let closed = false;
  let pending: { header: ScreenFrameHeader; resolve(): void; cancel(): void } | undefined;
  let epoch = 0;
  let cancelKeyframe: (() => void) | undefined;
  const reset = () => {
    epoch++;
    cancelKeyframe?.();
    cancelKeyframe = undefined;
    requested = false;
    decoder?.close();
    decoder = undefined;
    pending?.cancel();
    pending?.resolve();
    pending = undefined;
    waiting = true;
  };
  const recover = () => {
    waiting = true;
    if (!requested) {
      requested = true;
      ports.keyframe();
      cancelKeyframe = ports.schedule(() => {
        cancelKeyframe = undefined;
        requested = false;
        if (!closed && !failed && waiting) recover();
      }, 1000);
    }
  };
  const fallback = () => {
    reset();
    if (!failed && !closed) {
      failed = true;
      ports.fallback();
    }
  };
  return {
    async render(frame: PortableFrame): Promise<void> {
      if (closed) return;
      const h = frame.header;
      const seq = h.version === 1 ? h.sequence : h.seq;
      if (h.sessionId !== stream) {
        reset();
        stream = h.sessionId;
        previous = -1;
        requested = false;
        failed = false;
      }
      if (seq <= previous) return;
      const gap = previous >= 0 && seq !== previous + 1;
      previous = seq;
      if (h.codec === "jpeg") {
        reset();
        try {
          await ports.image(frame);
        } catch {
          ports.fallback();
        }
        return;
      }
      if (failed) return;
      if (!waiting && (gap || (decoder?.decodeQueueSize ?? 0) >= 2) && !h.keyframe) {
        ports.pressure();
        reset();
        recover();
        return;
      }
      if (waiting && !h.keyframe) {
        recover();
        return;
      }
      if (h.keyframe) {
        cancelKeyframe?.();
        cancelKeyframe = undefined;
        requested = false;
        const changed =
          h.width !== width || h.height !== height || (h.videoCodec && codec !== h.videoCodec);
        if (changed || !decoder) {
          reset();
          width = h.width;
          height = h.height;
          codec = h.videoCodec ?? "avc1.42E01F";
          const stamp = epoch;
          try {
            decoder = ports.decoder(
              h,
              (image) => {
                try {
                  if (!closed && stamp === epoch && pending) ports.video(image, pending.header);
                } finally {
                  image.close();
                  if (stamp === epoch) {
                    pending?.cancel();
                    pending?.resolve();
                    pending = undefined;
                  }
                }
              },
              (reason = "unsupported") => {
                if (stamp !== epoch) return;
                if (reason === "decode") {
                  ports.pressure();
                  reset();
                  recover();
                } else fallback();
              },
            );
          } catch {
            fallback();
            return;
          }
        }
        waiting = false;
      }
      if (!decoder) return;
      await new Promise<void>((resolve) => {
        pending = {
          header: h,
          resolve,
          cancel: ports.schedule(() => {
            // A scheduling stall says nothing about codec support. Drop the decode and
            // recover from a keyframe; only an actual decoder error negotiates JPEG.
            ports.pressure();
            reset();
            recover();
          }, 500),
        };
        try {
          decoder?.decode(frame);
        } catch {
          // A bad chunk or decoder state does not make the codec unsupported.
          ports.pressure();
          reset();
          recover();
        }
      });
    },
    reset() {
      reset();
      previous = -1;
      requested = false;
    },
    close() {
      closed = true;
      reset();
    },
  };
}

/** Browser I/O shell; the delivery/recovery rules above are exercised with deterministic ports. */
export function deviceCanvasRenderer(
  canvas: HTMLCanvasElement,
  options: {
    keyframe(): void;
    fallback(): void;
    pressure(): void;
    displayed?(header: ScreenFrameHeader): void;
  },
) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Device canvas unavailable");
  let active = true;
  let generation = 0;
  const draw = (image: CanvasImageSource, header: ScreenFrameHeader) => {
    if (!active) return;
    if (canvas.width !== header.width) canvas.width = header.width;
    if (canvas.height !== header.height) canvas.height = header.height;
    context.drawImage(image, 0, 0);
    canvas.dataset["frame"] = String(header.version === 1 ? header.sequence : header.seq);
    options.displayed?.(header);
  };
  const renderer = createDeviceRenderer({
    ...options,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    decoder: (header, output, error) => {
      const decoder = new VideoDecoder({
        output,
        error: (failure) => error(failure.name === "NotSupportedError" ? "unsupported" : "decode"),
      });
      try {
        decoder.configure({
          codec: header.videoCodec ?? "avc1.42E01F",
          codedWidth: header.width,
          codedHeight: header.height,
          optimizeForLatency: true,
        });
      } catch (failure) {
        decoder.close();
        throw failure;
      }
      return {
        get decodeQueueSize() {
          return decoder.decodeQueueSize;
        },
        decode: (frame) =>
          decoder.decode(
            new EncodedVideoChunk({
              type: frame.header.keyframe ? "key" : "delta",
              timestamp:
                (frame.header.version === 1 ? frame.header.sequence : frame.header.seq) * 1000,
              data: frame.payload,
            }),
          ),
        close: () => {
          if (decoder.state !== "closed") decoder.close();
        },
      };
    },
    video: (image, header) => {
      if (image instanceof VideoFrame) draw(image, header);
    },
    image: async (frame) => {
      const stamp = generation;
      const image = await createImageBitmap(new Blob([frame.payload], { type: "image/jpeg" }));
      try {
        if (stamp === generation) draw(image, frame.header);
      } finally {
        image.close();
      }
    },
  });
  return {
    render: renderer.render,
    reset: () => {
      generation++;
      renderer.reset();
    },
    close() {
      active = false;
      generation++;
      renderer.close();
    },
  };
}
export async function deviceVideoSupported(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    return (
      (await VideoDecoder.isConfigSupported({ codec: "avc1.42E01F", optimizeForLatency: true }))
        .supported === true
    );
  } catch {
    return false;
  }
}

export { coalescedPointerMoves } from "./pointer-moves.ts";
