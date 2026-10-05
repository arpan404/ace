import {
  coalescedPointerMoves,
  deviceCanvasRenderer,
  deviceVideoSupported,
  deviceStreamProfile,
} from "@ace/client/devices";
import type { DeviceInput } from "@ace/protocol";
import { deviceGesture, devicePoint, type FrameSize } from "@ace/ui-core";
import { useEffect, useRef, type PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";
import type { DeviceSession } from "./device-session.ts";

export function DeviceScreen(props: {
  session: DeviceSession;
  deviceId: string;
  name: string;
  interactive: boolean;
  onInput(input: DeviceInput): void | Promise<void>;
}) {
  const cursor = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLCanvasElement>(null);
  const latestInput = useRef(props.onInput);
  useEffect(() => {
    latestInput.current = props.onInput;
  }, [props.onInput]);
  const pointerStream = useRef<
    | {
        moves: ReturnType<typeof coalescedPointerMoves<{ x: number; y: number }>>;
        send(phase: "down" | "up" | "cancel", point: { x: number; y: number }): void;
      }
    | undefined
  >(undefined);
  const frame = useRef<FrameSize | undefined>(undefined);
  const press = useRef<{ x: number; y: number; at: number; pointer: number } | undefined>(
    undefined,
  );
  const { session, deviceId } = props;

  useEffect(() => {
    const element = image.current;
    if (!element) return;
    let disposed = false,
      video = false,
      pressure = 0;
    let live = false,
      configured = "",
      recovering = false;
    let lastPressure = 0,
      stableSince = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const configure = () => {
      if (disposed || !live) return;
      const parent = element.parentElement?.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
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
    const renderer = deviceCanvasRenderer(element, {
      keyframe: () => {
        if (disposed || recovering) return;
        recovering = true;
        void session.client
          .request({ op: "stream.keyframe", deviceId })
          .catch(() => {})
          .finally(() => {
            recovering = false;
          });
      },
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
      displayed: (header) => {
        const previous = frame.current;
        if (
          previous &&
          (previous.width !== header.width ||
            previous.height !== header.height ||
            previous.scale !== header.scale)
        ) {
          if (press.current) pointerStream.current?.send("cancel", press.current);
          press.current = undefined;
          if (cursor.current) cursor.current.style.display = "none";
        }
        frame.current = header;
      },
    });
    const release = session.client.watchFrames(deviceId, async (next) => {
      if (document.visibilityState === "hidden") {
        renderer.reset();
        return;
      }
      await renderer.render(next);
    });
    const moves = coalescedPointerMoves<{ x: number; y: number }>(
      async (point) => {
        await latestInput.current({ kind: "pointer", phase: "move", ...point });
      },
      () => {},
    );
    const stream = {
      moves,
      send: (phase: "down" | "up" | "cancel", point: { x: number; y: number }) => {
        moves.discard();
        void latestInput.current({ kind: "pointer", phase, ...point });
      },
    };
    const unwatch = session.client.watch((snapshot) => {
      const state = snapshot.states.find((candidate) => candidate.device.id === deviceId);
      pointerStream.current = state?.device.platform === "ios" ? stream : undefined;
      const next = state?.lifecycle === "live";
      if (next !== live) {
        live = next;
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
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(configure, 160);
    });
    if (element.parentElement) observer.observe(element.parentElement);
    const onVisibility = () => {
      renderer.reset();
      if (press.current) stream.send("cancel", press.current);
      press.current = undefined;
      if (cursor.current) cursor.current.style.display = "none";
      if (document.visibilityState !== "hidden") {
        configured = "";
        configure();
        void session.client.request({ op: "stream.keyframe", deviceId }).catch(() => {});
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
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (press.current) stream.send("cancel", press.current);
      moves.close();
      pointerStream.current = undefined;
      release();
      unwatch();
      renderer.close();
      frame.current = undefined;
      press.current = undefined;
    };
  }, [session, deviceId]);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const size = frame.current;
    if (!size) return undefined;
    return devicePoint(size, event.currentTarget.getBoundingClientRect(), {
      x: event.clientX,
      y: event.clientY,
    });
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
        )}
        onPointerDown={(event) => {
          if (!props.interactive || press.current) return;
          const at = point(event);
          if (!at) return;
          showCursor(event);
          press.current = { ...at, at: event.timeStamp, pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerStream.current?.send("down", at);
        }}
        onPointerMove={(event) => {
          if (!props.interactive || press.current?.pointer !== event.pointerId) return;
          showCursor(event);
          const at = point(event);
          if (at) pointerStream.current?.moves.move(at);
        }}
        onPointerCancel={() => {
          if (cursor.current) cursor.current.style.display = "none";
          if (press.current) pointerStream.current?.send("cancel", press.current);
          press.current = undefined;
        }}
        onPointerUp={(event) => {
          if (cursor.current) cursor.current.style.display = "none";
          const start = press.current;
          press.current = undefined;
          const end = point(event);
          if (!start || start.pointer !== event.pointerId || !end || !props.interactive) return;
          if (pointerStream.current) pointerStream.current.send("up", end);
          else void props.onInput(deviceGesture(start, { ...end, at: event.timeStamp }));
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
