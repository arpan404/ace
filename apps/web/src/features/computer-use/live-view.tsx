import { deviceCanvasRenderer } from "@ace/client/devices";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn.ts";
import type { ScreenSession } from "./screen-session.ts";

/**
 * An app window's live picture on a canvas, with no React render per frame. Frames are routed
 * by session id. Mounting subscribes; unmounting (or a new channel) unsubscribes and closes the
 * decoder and every decoded frame; a hidden page drops frames instead of drawing them.
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
    // The screen channel has no keyframe or stream-size requests: a new frame recovers.
    let renderer: ReturnType<typeof deviceCanvasRenderer>;
    try {
      renderer = deviceCanvasRenderer(element, {
        keyframe: () => {},
        fallback: () => {},
        pressure: () => {},
      });
    } catch {
      return; // No 2D canvas here: the card still says what the agent is doing.
    }
    let unwatch: (() => void) | undefined;
    try {
      unwatch = session.watchFrames(sessionId, async (frame) => {
        if (document.visibilityState === "hidden") {
          renderer.reset();
          return;
        }
        await renderer.render(frame);
      });
    } catch {
      // Eight live views at most; this one stays a still placeholder.
    }
    void session.request({ op: "subscribe", sessionId }).catch(() => {});
    const onVisibility = () => renderer.reset();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unwatch?.();
      renderer.close();
      void session.request({ op: "unsubscribe", sessionId }).catch(() => {});
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
