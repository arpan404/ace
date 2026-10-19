import { useLayoutEffect, useRef, type CSSProperties, type Ref } from "react";
import type { ScreenFrame } from "../sources.ts";

/**
 * A live frame's picture: a JPEG in an `<img>`, or a decoded video picture on a `<canvas>` whose
 * bitmap is the picture's own pixels (the pane's CSS size times its device pixel ratio, ADR 0088),
 * so nothing is scaled up by CSS. Either way the picture's intrinsic size is its pixels, and the
 * same classes fit it to the pane.
 */
export function FramePicture(props: {
  frame: ScreenFrame;
  alt: string;
  width?: number | undefined;
  height?: number | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Where the shown picture element goes (an `<img>` or a `<canvas>`). */
  pictureRef?: Ref<HTMLElement | null> | undefined;
}) {
  const { frame, pictureRef } = props;
  if (frame.video)
    return (
      <VideoPicture
        video={frame.video}
        alt={props.alt}
        className={props.className}
        style={props.style}
        pictureRef={pictureRef}
      />
    );
  return (
    <img
      data-page-picture=""
      ref={(element) => assign(pictureRef, element)}
      src={frame.src}
      alt={props.alt}
      draggable={false}
      style={props.style}
      width={props.width}
      height={props.height}
      className={props.className}
    />
  );
}

function VideoPicture(props: {
  video: NonNullable<ScreenFrame["video"]>;
  alt: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  pictureRef?: Ref<HTMLElement | null> | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { video } = props;
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (element.width !== video.codedWidth) element.width = video.codedWidth;
    if (element.height !== video.codedHeight) element.height = video.codedHeight;
    video.draw(element);
  }, [video]);
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
      // Like an `<img>` of a device-pixel JPEG, the bitmap's size is its intrinsic size, and the
      // same classes fit it to the pane.
      style={props.style}
      className={props.className}
    />
  );
}

/** Hands the element to a ref given for any picture element. */
function assign(ref: Ref<HTMLElement | null> | undefined, element: HTMLElement | null): void {
  if (typeof ref === "function") ref(element);
  else if (ref) ref.current = element;
}
