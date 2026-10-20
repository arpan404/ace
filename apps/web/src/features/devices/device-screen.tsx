import {
  coalescedPointerMoves,
  DeviceClientError,
  deviceVideoSupported,
  deviceStreamProfile,
  type DevicePicture,
} from "@ace/client/devices";
import type { DeviceInput } from "@ace/protocol";
import { deviceGesture, devicePoint, type FrameSize } from "@ace/ui-core";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { webCodecsDecoder } from "@/lib/video/codecs.ts";
import { TouchGestures, type TouchEffect } from "@/lib/touch-gestures.ts";
import type { DeviceSession } from "./device-session.ts";
import { nextFrame } from "@/lib/next-frame.ts";
import { pictureRenderer, type PictureImage } from "@/lib/video/picture-renderer.ts";
import { drawUpright } from "@/lib/video/picture-canvas.ts";
import { DeviceFingers, pinchPartner } from "./device-fingers.ts";
import { Problem } from "./device-problem.tsx";
import type { DeviceProblem } from "./use-devices.ts";

/** Live views are H.264 only: a browser that can't decode it gets this instead of a picture. */
const noDecoder: DeviceProblem = {
  message: "This browser can't decode H.264 video",
  hint: "Live views are video only. Open this device in a browser with WebCodecs H.264, such as current Chrome, Edge or Safari.",
};
/**
 * Why the daemon refused this view's stream, in its own words: its hint names the fix (the
 * serve-sim install, why scrcpy didn't start), which a generic line per code would lose.
 */
function streamProblem(error: unknown): DeviceProblem {
  if (error instanceof DeviceClientError) return { message: error.message, hint: error.hint };
  return { message: "The live view couldn't start its video.", hint: "Try again." };
}

type Touch = "multi" | "pointer" | "gestures";

/** A picture as the screen drew it, upright: for a frame drawn around it and the stream's stats. */
export interface ShownScreen {
  /** Upright size in pixels, and the pixels per point. */
  width: number;
  height: number;
  scale: number;
  /** Degrees clockwise the picture was turned to stand upright (a turned Simulator's). */
  rotation: number;
  /** When it was captured, on the daemon's clock. */
  capturedAt: number;
}

/** Which finger an input moves (-1: not a finger). */
const finger = (input: DeviceInput) => (input.kind === "pointer" ? (input.pointerId ?? 0) : -1);
/** A pointer event where it is on screen and on the device. */
const at = (event: PointerEvent<HTMLCanvasElement>, page: { x: number; y: number }) => ({
  screen: { x: event.clientX, y: event.clientY },
  page,
});
/** A mouse pinch's mirrored finger, apart from any real pointer id. */
const partnerId = 1_000_000;

/** Told of each picture that reaches the page and each keyframe the view asks for. */
export interface StreamObserver {
  receive(at: number, bytes: number): void;
  keyframeAsked(at: number): void;
}

/**
 * The device's live screen on a canvas, with no React render per frame. Pictures come on the
 * shared media stream as H.264 at 60 fps, decoded with WebCodecs and acked as they decode; the newest is drawn at each refresh, and a
 * landscape picture is turned upright. A browser without an H.264 decoder, or a device that can't
 * stream video, shows why instead of a picture. Unmounting, a reconnect (a new
 * session) or a hidden page closes the decoder and its frames. With control, fingers stream
 * live (several at once where the device takes them; Option-drag pinches with a mouse); a
 * device that takes only whole gestures gets a tap, swipe or long press.
 */
export function DeviceScreen(props: {
  session: DeviceSession;
  deviceId: string;
  name: string;
  interactive: boolean;
  onInput(input: DeviceInput): void | Promise<void>;
  /** Each picture as it is drawn. */
  onFrame?(shown: ShownScreen): void;
  /** The stream's arrivals and keyframe requests, for its stats (`StreamMeter`). */
  stream?: StreamObserver | undefined;
  /** Classes for the canvas, over its defaults (a drawn device frame clips the corners). */
  className?: string;
}) {
  const cursor = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLCanvasElement>(null);
  const latestInput = useRef(props.onInput);
  const latestFrame = useRef(props.onFrame);
  const latestStream = useRef(props.stream);
  useEffect(() => {
    latestInput.current = props.onInput;
    latestFrame.current = props.onFrame;
    latestStream.current = props.stream;
  }, [props.onInput, props.onFrame, props.stream]);
  const touch = useRef<Touch>("gestures");
  /** Why there is no picture: no H.264 decoder here, or the daemon refused the video. */
  const [unavailable, setUnavailable] = useState<DeviceProblem | undefined>();
  const frame = useRef<FrameSize | undefined>(undefined);
  /** The live touch sequence: its gesture reader, the device's fingers and coalesced moves. */
  const live = useRef<
    | {
        gestures: TouchGestures;
        fingers: DeviceFingers;
        pointers: Set<number>;
        /** Each finger's newest move not yet sent; sent together, a few batches in flight. */
        moved: Map<number, DeviceInput>;
        moves: ReturnType<typeof coalescedPointerMoves<true>>;
      }
    | undefined
  >(undefined);
  const press = useRef<{ x: number; y: number; at: number; pointer: number } | undefined>(
    undefined,
  );
  const { session, deviceId } = props;

  const send = (inputs: readonly DeviceInput[]) => {
    for (const input of inputs) void latestInput.current(input);
  };
  /** Lift every finger the device holds (lost pointer, resize, hidden page, unmount). */
  const cancelTouches = () => {
    const sequence = live.current;
    if (!sequence) return;
    sequence.moved.clear();
    sequence.moves.discard();
    sequence.gestures.cancel();
    sequence.pointers.clear();
    send(sequence.fingers.cancel());
  };

  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const context = element.getContext("2d", { alpha: false });
    if (!context) return;
    let disposed = false,
      pressure = 0;
    /** Whether this browser decodes H.264: unknown until WebCodecs answers. */
    let decodes: boolean | undefined;
    let streaming = false,
      configured = "";
    let lastPressure = 0,
      stableSince = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    /** The newest picture a hidden page didn't show: acked when the page shows again. */
    let owed: DevicePicture | undefined;
    const cannotDecode = () => {
      decodes = false;
      setUnavailable(noDecoder);
    };
    const configure = () => {
      if (disposed || !streaming || !decodes) return;
      const parent = element.parentElement?.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const settings = deviceStreamProfile(
        { width: (parent?.width ?? 480) * ratio, height: (parent?.height ?? 900) * ratio },
        session.connection ?? "local",
        pressure,
      );
      const signature = JSON.stringify(settings);
      if (signature === configured) return;
      configured = signature;
      void session.client.request({ op: "stream.configure", deviceId, settings }).then(
        () => {
          if (!disposed && decodes) setUnavailable(undefined);
        },
        (error: unknown) => {
          configured = "";
          if (!disposed && decodes) setUnavailable(streamProblem(error));
        },
      );
    };
    const show = (picture: PictureImage, shown: DevicePicture) => {
      if (disposed) return;
      const { width, height } = drawUpright(element, context, picture, shown);
      element.dataset["frame"] = String(shown.sequence);
      latestFrame.current?.({
        width,
        height,
        scale: shown.scale,
        rotation: shown.rotation,
        capturedAt: shown.timestamp,
      });
      const previous = frame.current;
      if (
        previous &&
        (previous.width !== shown.width ||
          previous.height !== shown.height ||
          previous.scale !== shown.scale ||
          previous.rotation !== shown.rotation)
      ) {
        // The screen changed under the fingers: they lift rather than land somewhere else.
        cancelTouches();
        press.current = undefined;
        if (cursor.current) cursor.current.style.display = "none";
      }
      frame.current = {
        width: shown.width,
        height: shown.height,
        scale: shown.scale,
        rotation: shown.rotation,
      };
    };
    // Video only: no JPEG decoder, and a platform that refuses H.264 says so.
    const renderer = pictureRenderer<DevicePicture>({
      decoder: webCodecsDecoder(),
      nextFrame,
      show,
      ack: (picture, keyframe) => {
        if (keyframe) latestStream.current?.keyframeAsked(Date.now());
        session.client.ack(picture, keyframe);
      },
      fallback: cannotDecode,
      pressure: () => {
        const now = performance.now();
        stableSince = now;
        if (now - lastPressure < 1500) return;
        lastPressure = now;
        pressure = Math.min(3, pressure + 1);
        configure();
      },
    });
    const release = session.client.watchPictures(deviceId, async (next) => {
      latestStream.current?.receive(Date.now(), next.bytes.length);
      if (document.visibilityState === "hidden") {
        // Nothing draws it: hold the ack, so the daemon stops sending until the page shows.
        renderer.reset();
        owed = next;
        return;
      }
      await renderer.render(next);
    });
    const unwatch = session.client.watch((snapshot) => {
      const state = snapshot.states.find((candidate) => candidate.device.id === deviceId);
      const next: Touch =
        state?.touch ?? (state?.device.platform === "ios" ? "pointer" : "gestures");
      if (next !== touch.current) {
        cancelTouches();
        live.current = undefined;
        touch.current = next;
      }
      const isLive = state?.lifecycle === "live";
      if (isLive !== streaming) {
        streaming = isLive;
        configured = "";
        configure();
      }
    });
    void deviceVideoSupported().then((supported) => {
      if (disposed || decodes === false) return;
      if (!supported) return cannotDecode();
      decodes = true;
      configured = "";
      configure();
    });
    // A resized panel asks for a matching stream; the daemon's next keyframe resets the decoder.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(configure, 160);
          });
    if (element.parentElement) observer?.observe(element.parentElement);
    const onVisibility = () => {
      renderer.reset();
      cancelTouches();
      press.current = undefined;
      if (cursor.current) cursor.current.style.display = "none";
      if (document.visibilityState !== "hidden") {
        configured = "";
        configure();
        // The held ack opens the window again and asks for a picture to start from.
        if (owed) session.client.ack(owed, true);
        else void session.client.request({ op: "stream.keyframe", deviceId }).catch(() => {});
        owed = undefined;
      }
    };
    const recoverQuality = () => {
      if (disposed) return;
      if (pressure && performance.now() - stableSince > 10000) {
        pressure--;
        stableSince = performance.now();
        configure();
      }
      timer = setTimeout(recoverQuality, 2000);
    };
    recoverQuality();
    window.addEventListener("resize", configure);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      observer?.disconnect();
      window.removeEventListener("resize", configure);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelTouches();
      live.current?.moves.close();
      live.current = undefined;
      release();
      unwatch();
      renderer.close();
      frame.current = undefined;
      press.current = undefined;
    };
    // `cancelTouches` reads refs only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [session, deviceId]);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const size = frame.current;
    if (!size) return undefined;
    return devicePoint(size, event.currentTarget.getBoundingClientRect(), {
      x: event.clientX,
      y: event.clientY,
    });
  };
  const sequence = () => {
    if (live.current) return live.current;
    const moved = new Map<number, DeviceInput>();
    live.current = {
      gestures: new TouchGestures(),
      fingers: new DeviceFingers(touch.current === "multi"),
      pointers: new Set(),
      moved,
      moves: coalescedPointerMoves<true>(
        async () => {
          const batch = [...moved.values()];
          moved.clear();
          // Sent in order at once: the transport keeps the order, so fingers don't wait in turn.
          await Promise.all(batch.map((input) => latestInput.current(input)));
        },
        () => {},
      ),
    };
    return live.current;
  };
  /** Hands a touch sequence's effects to the device: ends at once, moves coalesced. */
  const apply = (effects: TouchEffect[]) => {
    const current = live.current;
    if (!current) return;
    for (const effect of effects) {
      if (effect.type !== "input") continue;
      const inputs = current.fingers.touch(effect.input);
      const moves = inputs.filter((input) => input.phase === "move");
      if (moves.length === inputs.length) {
        for (const input of moves) current.moved.set(input.pointerId ?? 0, input);
        if (moves.length) current.moves.move(true);
        continue;
      }
      // A finger lands or lifts: it goes at once, after the other fingers' unsent moves.
      const others = [...current.moved.values()].filter(
        (move) => !inputs.some((input) => finger(input) === finger(move)),
      );
      current.moved.clear();
      current.moves.discard();
      send([...others, ...inputs]);
    }
  };
  const screenPoints = () => {
    const size = frame.current;
    const scale = size?.scale ?? 1;
    return size && { width: size.width / scale, height: size.height / scale };
  };

  const showCursor = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!cursor.current) return;
    cursor.current.style.display = "block";
    cursor.current.style.transform = `translate(${event.clientX - 8}px, ${event.clientY - 8}px)`;
  };
  return (
    <>
      <canvas
        ref={image}
        role="img"
        aria-label={`${props.name} screen`}
        draggable={false}
        className={cn(
          "block h-auto max-h-full w-auto max-w-full touch-none rounded-[22px] bg-black object-contain select-none shadow-[0_0_0_1px_var(--border)]",
          props.interactive ? "cursor-pointer" : "cursor-default",
          props.className,
        )}
        onPointerDown={(event) => {
          if (!props.interactive) return;
          const target = point(event);
          if (!target) return;
          showCursor(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          if (touch.current === "gestures") {
            if (press.current) return;
            press.current = { ...target, at: event.timeStamp, pointer: event.pointerId };
            return;
          }
          const current = sequence();
          if (current.pointers.has(event.pointerId)) return;
          current.pointers.add(event.pointerId);
          apply(current.gestures.down(event.pointerId, at(event, target), event.timeStamp));
          const screen = screenPoints();
          if (event.pointerType === "mouse" && event.altKey && touch.current === "multi" && screen)
            apply(
              current.gestures.down(
                partnerId,
                at(event, pinchPartner(target, screen)),
                event.timeStamp,
              ),
            );
        }}
        onPointerMove={(event) => {
          if (!props.interactive) return;
          if (touch.current === "gestures") {
            if (press.current?.pointer === event.pointerId) showCursor(event);
            return;
          }
          const current = live.current;
          if (!current?.pointers.has(event.pointerId)) return;
          showCursor(event);
          const target = point(event);
          if (!target) return;
          apply(current.gestures.move(event.pointerId, at(event, target)));
          const screen = screenPoints();
          if (screen && current.fingers.held > 1)
            apply(current.gestures.move(partnerId, at(event, pinchPartner(target, screen))));
        }}
        onPointerCancel={() => {
          if (cursor.current) cursor.current.style.display = "none";
          press.current = undefined;
          cancelTouches();
        }}
        onPointerUp={(event) => {
          if (cursor.current) cursor.current.style.display = "none";
          const target = point(event);
          if (touch.current !== "gestures") {
            const current = live.current;
            if (!current?.pointers.delete(event.pointerId)) return;
            const ended = target && at(event, target);
            apply(current.gestures.up(partnerId, undefined, event.timeStamp));
            apply(current.gestures.up(event.pointerId, ended, event.timeStamp));
            return;
          }
          const start = press.current;
          press.current = undefined;
          if (!start || start.pointer !== event.pointerId || !target || !props.interactive) return;
          void props.onInput(deviceGesture(start, { ...target, at: event.timeStamp }));
        }}
      />
      <span
        ref={cursor}
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 z-50 h-4 w-4 rounded-full border border-white bg-white/20"
        style={{ display: "none" }}
      />
      {unavailable && (
        <div className="absolute inset-0 grid place-items-center bg-background p-6 text-center">
          <Problem problem={unavailable} />
        </div>
      )}
    </>
  );
}
