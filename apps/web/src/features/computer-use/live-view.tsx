import type { SourcePicture } from "@ace/client/screen-stream";
import { deviceVideoSupported, screenStreamProfile } from "@ace/client/devices";
import type { ScreenInput } from "@ace/protocol";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { webCodecsDecoder } from "@/lib/video/codecs.ts";
import { drawUpright } from "@/lib/video/picture-canvas.ts";
import { nextFrame } from "@/lib/next-frame.ts";
import { later } from "@/lib/later.ts";
import { pictureRenderer } from "@/lib/video/picture-renderer.ts";
import type { ScreenSession } from "./screen-session.ts";
import { keyInput, pointerGesture, windowPoint, type ShownPicture } from "./live-input.ts";

/** A scroll in whole points, within what the window may be sent at once. */
function clamp(value: number): number {
  return Math.max(-1000, Math.min(1000, Math.round(value)));
}

/**
 * An app window's live picture on a canvas, with no React render per frame. Pictures come on the
 * shared media stream (stream kind `screenFrame`) and draw through the same renderer as a
 * device's, the newest at each refresh: the view asks the Mac's helper for 60 fps hardware H.264
 * sized to its panel and link. It is video only: where the browser can't decode H.264 or the
 * helper can't encode it, the view says so instead of showing stills. Mounting holds
 * the session's stream (shared with every other view of it); unmounting (or a new channel) lets
 * it go and closes the decoder. A hidden page holds its newest ack, so the daemon stops sending,
 * and acks it with a keyframe request when the page shows again.
 */
export function LiveView(props: {
  session: ScreenSession;
  sessionId: string;
  label: string;
  className?: string;
  /** Set while the person controls the window: clicks, drags, wheel and keys go to it. */
  onInput?: ((input: ScreenInput) => void) | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The newest picture's size and scale, to turn a page point into a window point. */
  const shownRef = useRef({ width: 0, height: 0, scale: 1 });
  const wheelRef = useRef<{ at: { x: number; y: number }; dx: number; dy: number }>(undefined);
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const press = useRef<{
    page: { x: number; y: number };
    at: { x: number; y: number };
    button: number;
    time: number;
  }>(undefined);
  /** Why there is no picture: live views are video only, never a slideshow of stills. */
  const [noVideo, setNoVideo] = useState<string>();
  const { session, sessionId } = props;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d", { alpha: false });
    // No 2D canvas here: the card still says what the agent is doing.
    if (!context) return;
    let disposed = false;
    /** The newest picture a hidden page didn't show: acked when the page shows again. */
    let owed: SourcePicture | undefined;
    /** Whether this browser decodes H.264: until it says so, the session stays on stills. */
    let decodes = false;
    let configured = "";
    let pressure = 0;
    let lastPressure = 0;
    let stableSince = performance.now();
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let recoverTimer: ReturnType<typeof setTimeout> | undefined;
    /** Ask the helper for 60 fps H.264 sized to this panel and link (the Mac's encoder). */
    const configure = () => {
      if (disposed || !decodes) return;
      const parent = element.parentElement?.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const settings = screenStreamProfile(
        { width: (parent?.width ?? 1280) * ratio, height: (parent?.height ?? 800) * ratio },
        session.connection,
        pressure,
      );
      const signature = JSON.stringify(settings);
      if (signature === configured) return;
      configured = signature;
      void session.request({ op: "stream.configure", sessionId, settings }).then(
        (result) => {
          if (disposed) return;
          // Only a Mac's helper encodes video; elsewhere the view says so rather than show stills.
          const codec = (result as { codec?: unknown } | undefined)?.codec;
          setNoVideo(codec === "h264" ? undefined : "This computer can't stream video of its apps");
        },
        () => {
          configured = "";
        },
      );
    };
    const renderer = pictureRenderer<SourcePicture>({
      decoder: webCodecsDecoder(),
      nextFrame,
      after: later,
      stalled: () => {
        if (!disposed) setNoVideo("The live view stopped. Open the app again.");
      },
      show: (image, picture) => {
        if (disposed) return;
        drawUpright(element, context, image, picture);
        shownRef.current = { width: picture.width, height: picture.height, scale: picture.scale };
        element.dataset["frame"] = String(picture.sequence);
      },
      ack: (picture, keyframe) => session.ack(picture, keyframe),
      fallback: () => {
        if (!disposed) setNoVideo("This browser can't decode video");
      },
      // The view fell behind: a lighter stream, at most every 1.5 s; it recovers when steady.
      pressure: () => {
        const now = performance.now();
        stableSince = now;
        if (now - lastPressure < 1500) return;
        lastPressure = now;
        pressure = Math.min(3, pressure + 1);
        configure();
      },
    });
    let unwatch: (() => void) | undefined;
    try {
      unwatch = session.watchPictures(sessionId, async (picture) => {
        if (document.visibilityState === "hidden") {
          // Nothing draws it: hold the ack, so the daemon stops sending until the page shows.
          renderer.reset();
          owed = picture;
          return;
        }
        await renderer.render(picture);
      });
    } catch {
      // Eight live views at most; this one stays a still placeholder.
    }
    // Another view of this session (Settings and a thread's panel) shares its stream.
    const release = session.retainStream(sessionId);
    void deviceVideoSupported().then((supported) => {
      decodes = supported;
      if (!supported && !disposed) setNoVideo("This browser can't decode video");
      configure();
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(configure, 160);
          });
    if (element.parentElement) observer?.observe(element.parentElement);
    const recover = () => {
      if (pressure && performance.now() - stableSince > 10_000) {
        pressure--;
        stableSince = performance.now();
        configure();
      }
      recoverTimer = setTimeout(recover, 2000);
    };
    recover();
    const onVisibility = () => {
      renderer.reset();
      if (document.visibilityState === "hidden" || !owed) return;
      // The held ack opens the window again and asks for a picture to start from.
      session.ack(owed, true);
      owed = undefined;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      clearTimeout(recoverTimer);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unwatch?.();
      renderer.close();
      release();
    };
  }, [session, sessionId]);
  const onInput = props.onInput;
  useEffect(() => () => clearTimeout(wheelTimer.current), []);
  const point = (
    event:
      | PointerEvent<HTMLCanvasElement>
      | { clientX: number; clientY: number; currentTarget: HTMLCanvasElement },
  ) => {
    const box = event.currentTarget.getBoundingClientRect();
    const shown: ShownPicture = { box, ...shownRef.current };
    return windowPoint({ x: event.clientX, y: event.clientY }, shown);
  };
  return (
    <>
      <canvas
        ref={canvas}
        role="img"
        aria-label={props.label}
        tabIndex={onInput ? 0 : undefined}
        className={cn(
          "absolute inset-0 size-full object-contain",
          onInput && "focus-ring cursor-default touch-none",
          props.className,
        )}
        onContextMenu={(event) => onInput && event.preventDefault()}
        onPointerDown={(event) => {
          const at = onInput && point(event);
          if (!at) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          press.current = {
            page: { x: event.clientX, y: event.clientY },
            at,
            button: event.button,
            time: event.timeStamp,
          };
        }}
        onPointerUp={(event) => {
          const down = press.current;
          press.current = undefined;
          if (!down || !onInput) return;
          const input = pointerGesture(
            down,
            { page: { x: event.clientX, y: event.clientY }, at: point(event) },
            event.timeStamp - down.time,
          );
          if (input) onInput(input);
        }}
        onPointerCancel={() => {
          press.current = undefined;
        }}
        onWheel={(event) => {
          const at = onInput && point(event);
          if (!at) return;
          // A wheel fires many times a notch: what turns within 60 ms goes as one scroll.
          const wheel = (wheelRef.current ??= { at, dx: 0, dy: 0 });
          wheel.at = at;
          wheel.dx += event.deltaX;
          wheel.dy += event.deltaY;
          if (wheelTimer.current) return;
          wheelTimer.current = setTimeout(() => {
            wheelTimer.current = undefined;
            const turned = wheelRef.current;
            wheelRef.current = undefined;
            if (turned && (turned.dx || turned.dy))
              onInput({ kind: "scroll", ...turned.at, dx: clamp(turned.dx), dy: clamp(turned.dy) });
          }, 60);
        }}
        onKeyDown={(event) => {
          const input = onInput && keyInput(event);
          if (!input) return;
          event.preventDefault();
          onInput(input);
        }}
      />
      {noVideo && (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-muted-foreground"
        >
          {noVideo}
        </p>
      )}
    </>
  );
}
