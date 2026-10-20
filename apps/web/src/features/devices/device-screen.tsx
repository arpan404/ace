import {
  coalescedPointerMoves,
  deviceVideoSupported,
  deviceStreamProfile,
  type DevicePicture,
} from "@ace/client/devices";
import type { DeviceInput } from "@ace/protocol";
import { deviceGesture, devicePoint, type FrameSize } from "@ace/ui-core";
import { useEffect, useRef, type PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { webCodecsDecoder } from "@/lib/video/codecs.ts";
import { TouchGestures, type TouchEffect } from "@/lib/touch-gestures.ts";
import type { DeviceSession } from "./device-session.ts";
import { pictureRenderer, type PictureImage } from "@/lib/video/picture-renderer.ts";
import { drawUpright, jpegImage } from "@/lib/video/picture-canvas.ts";
import { DeviceFingers, pinchPartner } from "./device-fingers.ts";

type Touch = "multi" | "pointer" | "gestures";

/** A picture as the screen drew it, upright: for a frame drawn around it and the stream's stats. */
export interface ShownScreen {
  /** Upright size in pixels, and the pixels per point. */
  width: number;
  height: number;
  scale: number;
  codec: "jpeg" | "h264";
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

/**
 * The device's live screen on a canvas, with no React render per frame. Pictures come on the
 * shared media stream (H.264 through WebCodecs when it can decode it, JPEG otherwise) and are
 * acked as they show; a landscape picture is turned upright. Unmounting, a reconnect (a new
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
  /** Classes for the canvas, over its defaults (a drawn device frame clips the corners). */
  className?: string;
}) {
  const cursor = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLCanvasElement>(null);
  const latestInput = useRef(props.onInput);
  const latestFrame = useRef(props.onFrame);
  useEffect(() => {
    latestInput.current = props.onInput;
    latestFrame.current = props.onFrame;
  }, [props.onInput, props.onFrame]);
  const touch = useRef<Touch>("gestures");
  const frame = useRef<FrameSize | undefined>(undefined);
  /** The live touch sequence: its gesture reader, the device's fingers and coalesced moves. */
  const live = useRef<
    | {
        gestures: TouchGestures;
        fingers: DeviceFingers;
        pointers: Set<number>;
        /** Each finger's newest move not yet sent; sent together, one batch in flight. */
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
      video = false,
      pressure = 0;
    let streaming = false,
      configured = "";
    let lastPressure = 0,
      stableSince = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    /** The newest picture a hidden page didn't show: acked when the page shows again. */
    let owed: DevicePicture | undefined;
    const configure = () => {
      if (disposed || !streaming) return;
      const parent = element.parentElement?.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const settings = deviceStreamProfile(
        { width: (parent?.width ?? 480) * ratio, height: (parent?.height ?? 900) * ratio },
        session.connection ?? "local",
        video,
        pressure,
      );
      const signature = JSON.stringify(settings);
      if (signature === configured) return;
      configured = signature;
      void session.client.request({ op: "stream.configure", deviceId, settings }).catch(() => {
        configured = "";
      });
    };
    const show = (picture: PictureImage, shown: DevicePicture) => {
      if (disposed) return;
      const { width, height } = drawUpright(element, context, picture, shown);
      element.dataset["frame"] = String(shown.sequence);
      latestFrame.current?.({
        width,
        height,
        scale: shown.scale,
        codec: shown.codec === "jpeg" ? "jpeg" : "h264",
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
    const renderer = pictureRenderer<DevicePicture>({
      decoder: webCodecsDecoder(),
      image: jpegImage,
      show,
      ack: (picture, keyframe) => session.client.ack(picture, keyframe),
      fallback: () => {
        video = false;
        configured = "";
        configure();
      },
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
      if (disposed) return;
      video = supported;
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
          for (const input of batch) await latestInput.current(input);
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
    </>
  );
}
