import type { SourcePicture } from "@ace/client/screen-stream";
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
 * device's: JPEG, or the helper's H.264 through WebCodecs, the newest drawn at each refresh. Mounting holds
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
      // The helper's encoder follows its own policy; a view only says what it can't decode.
      fallback: () => {},
      pressure: () => {},
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
