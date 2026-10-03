import type { DeviceInput } from "@ace/protocol";
import { deviceGesture, devicePoint, type FrameSize } from "@ace/ui-core";
import { useEffect, useRef, type PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";
import type { DeviceSession } from "./device-session.ts";

/** Decoded before the next frame is taken, so a slow page drops frames instead of queueing. */
async function shown(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === "function") await image.decode().catch(() => {});
}

/**
 * The device's live screen. Frames go straight to the image element (no React render per
 * frame); only the newest frame waits while one decodes. With control, a press on the screen
 * becomes a tap, long press or swipe at the matching device point.
 */
export function DeviceScreen(props: {
  session: DeviceSession;
  deviceId: string;
  name: string;
  interactive: boolean;
  onInput(input: DeviceInput): void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const frame = useRef<FrameSize | undefined>(undefined);
  const press = useRef<{ x: number; y: number; at: number; pointer: number } | undefined>(
    undefined,
  );
  const { session, deviceId } = props;

  useEffect(() => {
    let url: string | undefined;
    const release = session.client.watchFrames(deviceId, async (next) => {
      const element = image.current;
      if (!element) return;
      const previous = url;
      url = URL.createObjectURL(new Blob([next.payload], { type: "image/jpeg" }));
      frame.current = next.header;
      element.src = url;
      element.dataset["frame"] = String(
        next.header.version === 1 ? next.header.sequence : next.header.seq,
      );
      await shown(element);
      if (previous) URL.revokeObjectURL(previous);
    });
    return () => {
      release();
      if (url) URL.revokeObjectURL(url);
      frame.current = undefined;
    };
  }, [session, deviceId]);

  const point = (event: PointerEvent<HTMLImageElement>) => {
    const size = frame.current;
    if (!size) return undefined;
    return devicePoint(size, event.currentTarget.getBoundingClientRect(), {
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <img
      ref={image}
      alt={`${props.name} screen`}
      draggable={false}
      className={cn(
        "mx-auto block h-auto max-h-[62vh] w-auto max-w-full touch-none rounded-[22px] bg-black object-contain select-none shadow-[0_0_0_1px_var(--border)]",
        props.interactive ? "cursor-pointer" : "cursor-default",
      )}
      onPointerDown={(event) => {
        if (!props.interactive || press.current) return;
        const at = point(event);
        if (!at) return;
        press.current = { ...at, at: event.timeStamp, pointer: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        press.current = undefined;
      }}
      onPointerUp={(event) => {
        const start = press.current;
        press.current = undefined;
        const end = point(event);
        if (!start || start.pointer !== event.pointerId || !end || !props.interactive) return;
        props.onInput(deviceGesture(start, { ...end, at: event.timeStamp }));
      }}
    />
  );
}
