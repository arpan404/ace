import { useContext, type CSSProperties, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useLightbox } from "@/components/attachment-open.tsx";
import { WebLink } from "@/components/web-link.tsx";
import { cn } from "@/lib/cn.ts";
import { InsideLink } from "./scope.ts";
import { useForgeMedia, type MediaView } from "./use-forge-media.ts";
import type { ReadyMedia } from "./media-loads.ts";

/*
 * Images and videos in forge text (ADR 0096). An image takes the size its text asks for
 * (`width`/`height`), else its own, never wider than the column; its space is held while it
 * loads, so the page doesn't jump. A click opens the viewer (unless the image is a link). A
 * video plays inline with controls. What can't be shown leaves one quiet line that offers the
 * original on GitHub.
 */

const pixels = /^\d{1,5}(?:\.\d+)?$/;

/** The box an image takes: its CSS width and aspect ratio, when known. */
export function imageBox(
  declared: { width?: string | undefined; height?: string | undefined },
  natural?: { width?: number | undefined; height?: number | undefined },
): { width?: string; aspectRatio?: number } {
  const width = declared.width && pixels.test(declared.width) ? Number(declared.width) : undefined;
  const height =
    declared.height && pixels.test(declared.height) ? Number(declared.height) : undefined;
  const percent = declared.width?.endsWith("%") ? declared.width : undefined;
  const ratio =
    natural?.width && natural.height
      ? natural.width / natural.height
      : width && height
        ? width / height
        : undefined;
  const box: { width?: string; aspectRatio?: number } = {};
  if (ratio) box.aspectRatio = ratio;
  if (width) box.width = `${width}px`;
  else if (percent) box.width = percent;
  else if (height && ratio) box.width = `${Math.round(height * ratio)}px`;
  else if (natural?.width) box.width = `${natural.width}px`;
  return box;
}

const alignClass: Record<string, string> = {
  left: "float-left mr-3 mb-2",
  right: "float-right ml-3 mb-2",
};

function MediaFallback(props: { what: string; reason?: string | undefined; href?: string }) {
  const text =
    props.reason === "too_large"
      ? `${props.what} is too large to show here.`
      : `${props.what} couldn't load.`;
  return (
    <span className="inline text-ui text-subtle-foreground">
      {text}
      {props.href && (
        <>
          {" "}
          <WebLink href={props.href} className="text-link hover:underline focus-ring">
            Open on GitHub
          </WebLink>
        </>
      )}
    </span>
  );
}

function Loaded(props: {
  media: ReadyMedia;
  url: string;
  alt: string;
  title?: string | undefined;
  style: CSSProperties;
  className?: string | undefined;
}) {
  const inLink = useContext(InsideLink);
  const { show, lightbox } = useLightbox([
    {
      key: props.media.sha256,
      name: props.alt || "Image",
      bytes: props.media.bytes,
      width: props.media.width,
      height: props.media.height,
      source: { kind: "url", url: props.url },
    },
  ]);
  const image = (
    <img
      src={props.url}
      alt={props.alt}
      title={props.title}
      draggable={false}
      style={props.style}
      className={cn(
        "inline-block h-auto max-w-full rounded-xs align-middle",
        !inLink && props.className,
      )}
    />
  );
  if (inLink) return image;
  return (
    <>
      <button
        type="button"
        aria-label={props.alt ? `View ${props.alt}` : "View image"}
        onClick={(event) => show(0, event.currentTarget)}
        className={cn(
          "inline-block max-w-full cursor-zoom-in rounded-xs align-middle focus-ring",
          props.className,
        )}
      >
        {image}
      </button>
      {lightbox}
    </>
  );
}

function Video(props: { view: Extract<MediaView, { phase: "ready" }> }) {
  return (
    // oxlint-disable-next-line jsx-a11y/media-has-caption -- people's screen recordings carry no captions.
    <video
      src={props.view.url}
      controls
      playsInline
      preload="metadata"
      className="block max-h-160 w-full max-w-full rounded-sm bg-surface-1"
    />
  );
}

/** `<img>` or `![alt](src)` in forge text. `src` is the URL as written (already checked safe). */
export function ForgeImage(props: {
  src: string;
  alt: string;
  title?: string | undefined;
  width?: string | undefined;
  height?: string | undefined;
  align?: string | undefined;
}): ReactNode {
  const view = useForgeMedia(props.src, "image");
  const media = view.phase === "loading" || view.phase === "ready" ? view.media : undefined;
  const box = imageBox(props, media);
  const style: CSSProperties = { width: box.width, aspectRatio: box.aspectRatio };
  const place = props.align ? alignClass[props.align] : undefined;
  if (view.phase === "ready" && view.media.kind === "video") return <Video view={view} />;
  if (view.phase === "ready")
    return (
      <Loaded
        media={view.media}
        url={view.url}
        alt={props.alt}
        title={props.title}
        style={style}
        className={place}
      />
    );
  if (view.phase === "loading")
    return (
      <Skeleton
        className={cn(
          "inline-block h-auto max-w-full rounded-xs align-middle",
          !box.width && "w-80",
          !box.aspectRatio && "aspect-video",
          place,
        )}
        style={style}
      />
    );
  return (
    <MediaFallback
      what={props.alt ? `“${props.alt}”` : "Image"}
      reason={view.phase === "unavailable" ? view.reason : undefined}
      href={props.src}
    />
  );
}

/**
 * A link alone on its line that GitHub may show as a player (an uploaded video). It stays the
 * link (`standard`) until the daemon says what it is.
 */
export function ForgeLinkMedia(props: { url: string; standard: ReactNode }): ReactNode {
  const view = useForgeMedia(props.url, "link");
  if (view.phase === "ready")
    return view.media.kind === "video" ? (
      <Video view={view} />
    ) : (
      <p>
        <Loaded media={view.media} url={view.url} alt="" style={imageBox({}, view.media)} />
      </p>
    );
  if (view.phase === "loading" && view.media)
    return <Skeleton className="block aspect-video h-auto w-full max-w-160 rounded-sm" />;
  if (view.phase === "unavailable" && view.reason === "too_large")
    return (
      <p>
        <MediaFallback what="Video" reason={view.reason} href={props.url} />
      </p>
    );
  return props.standard;
}
