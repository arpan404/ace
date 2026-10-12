import { useCallback, useState, type ReactNode } from "react";
import type { ImageSource } from "./attachment-format.ts";
import { ImageUrl, type ImageState } from "./attachment-bytes.tsx";

/** Clipped overflow rows acquire bytes only while their thumbnails are visible. */
export function VisibleImageUrl(props: {
  source: ImageSource | undefined;
  className: string;
  children(image: ImageState): ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const observe = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={observe} className={props.className}>
      {props.source && visible ? (
        <ImageUrl source={props.source}>{props.children}</ImageUrl>
      ) : (
        props.children({ state: props.source ? "loading" : "unavailable" })
      )}
    </span>
  );
}
