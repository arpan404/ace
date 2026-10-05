import { ArrowSquareOutIcon, ImageIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { displayName } from "./attachment-format.ts";

// The thumbnail and its lightbox load only when a message has an inline image.
const InlineImage = deferredComponent(() =>
  import("./attachment-tiles.tsx").then((module) => module.InlineImage),
);

/*
 * `![alt](src)` in agent prose. Only bytes already on this page are drawn: inline `data:image/`
 * and `blob:` URLs, as a thumbnail that opens the lightbox. A web image is never fetched on its
 * own (a URL an agent writes can track or leak whatever it encodes); it becomes a link the
 * person can choose to open. A path on the agent's machine can't be loaded by this page, so it
 * shows as a chip with the file's name, never the full path.
 */
export function MarkdownImage(props: { src: string; alt: string }) {
  const { src, alt } = props;
  if (/^(data:image\/|blob:)/i.test(src))
    return (
      <Suspense
        fallback={
          <Skeleton
            className="my-1 inline-block rounded-[10px]"
            style={{ width: 320, height: 240 }}
          />
        }
      >
        <InlineImage.Component src={src} alt={alt} />
      </Suspense>
    );
  const web = webUrl(src);
  if (web)
    return (
      <a
        href={web.href}
        target="_blank"
        rel="noreferrer noopener"
        className={chipClass + " hover:bg-accent hover:text-foreground"}
      >
        <ImageIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        <span className="min-w-0 truncate">{alt || displayName(web.pathname, "Image")}</span>
        <span className="shrink-0 text-subtle-foreground">{web.host}</span>
        <ArrowSquareOutIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </a>
    );
  const name = displayName(src, "Image");
  return (
    <Tip label="An image file on the agent's machine; it isn't loaded here">
      <span tabIndex={0} className={chipClass}>
        <ImageIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
        <span className="min-w-0 truncate">{alt && alt !== name ? `${alt} (${name})` : name}</span>
      </span>
    </Tip>
  );
}

const chipClass =
  "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-secondary px-2 align-middle text-xs text-muted-foreground no-underline";

function webUrl(src: string): URL | undefined {
  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
