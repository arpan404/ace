import { useLayoutEffect, useRef, type CSSProperties, type Ref } from "react";
import type { ScreenFrame } from "../sources.ts";

/**
 * A live page's picture: decoded video on a `<canvas>` whose bitmap is the picture's own pixels
 * (the pane's CSS size times its device pixel ratio, ADR 0088), so nothing is scaled up by CSS;
 * the bitmap's size is the canvas's intrinsic size, and the classes fit it to the pane.
 *
 * The canvas draws outside React: it draws the newest picture once on mount, then on the next
 * animation frame after each newer one arrives, however many arrived since (each replaced one
 * is already freed). A hidden page has no animation frames, so it draws nothing until shown.
 */
export function FramePicture(props: {
  frame: ScreenFrame;
  alt: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Where the canvas goes, for anything that maps points through the drawn picture. */
  pictureRef?: Ref<HTMLElement | null> | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { frame } = props;
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (element.width !== frame.codedWidth) element.width = frame.codedWidth;
    if (element.height !== frame.codedHeight) element.height = frame.codedHeight;
    const context = element.getContext("2d", { alpha: false });
    if (!context) return;
    let scheduled = 0;
    const paint = () => {
      scheduled = 0;
      frame.draw(context, element.width, element.height);
    };
    paint();
    const stop = frame.subscribe(() => {
      scheduled ||= requestAnimationFrame(paint);
    });
    return () => {
      stop();
      if (scheduled) cancelAnimationFrame(scheduled);
    };
  }, [frame]);
  const attach = (element: HTMLCanvasElement | null) => {
    canvas.current = element;
    assign(props.pictureRef, element);
  };
  return (
    <canvas
      data-page-picture=""
      ref={attach}
      role="img"
      aria-label={props.alt}
      style={props.style}
      className={props.className}
    />
  );
}

/** Hands the canvas to a ref given for the picture element. */
function assign(ref: Ref<HTMLElement | null> | undefined, element: HTMLElement | null): void {
  if (typeof ref === "function") ref(element);
  else if (ref) ref.current = element;
}
