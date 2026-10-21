import type { SourcePicture } from "@ace/client/screen-stream";
import { deviceVideoSupported, screenStreamProfile } from "@ace/client/devices";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn.ts";
import { webCodecsDecoder } from "@/lib/video/codecs.ts";
import { drawUpright, jpegImage } from "@/lib/video/picture-canvas.ts";
import { nextFrame } from "@/lib/next-frame.ts";
import { pictureRenderer } from "@/lib/video/picture-renderer.ts";
import type { ScreenSession } from "./screen-session.ts";

/**
 * An app window's live picture on a canvas, with no React render per frame. Pictures come on the
 * shared media stream (stream kind `screenFrame`) and draw through the same renderer as a
 * device's, the newest at each refresh. Where WebCodecs decodes H.264, the view asks the Mac's
 * helper for 60 fps hardware H.264 sized to its panel and link; otherwise it shows stills. Mounting holds
 * the session's stream (shared with every other view of it); unmounting (or a new channel) lets
 * it go and closes the decoder. A hidden page holds its newest ack, so the daemon stops sending,
 * and acks it with a keyframe request when the page shows again.
 */
export function LiveView(props: {
  session: ScreenSession;
  sessionId: string;
  label: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
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
      void session.request({ op: "stream.configure", sessionId, settings }).catch(() => {
        // A helper that can't (another OS, a stopped session) keeps sending stills.
        configured = "";
      });
    };
    const renderer = pictureRenderer<SourcePicture>({
      decoder: webCodecsDecoder(),
      nextFrame,
      image: jpegImage,
      show: (image, picture) => {
        if (disposed) return;
        drawUpright(element, context, image, picture);
        element.dataset["frame"] = String(picture.sequence);
      },
      ack: (picture, keyframe) => session.ack(picture, keyframe),
      fallback: () => {},
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
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={props.label}
      className={cn("absolute inset-0 size-full object-contain", props.className)}
    />
  );
}
