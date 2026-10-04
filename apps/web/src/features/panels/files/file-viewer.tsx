// oxlint-disable react/no-array-index-key -- skeleton lines have no identity; position is it.
import {
  DownloadSimpleIcon,
  FileDashedIcon,
  FileIcon,
  FileTextIcon,
  ImageBrokenIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
  WifiSlashIcon,
} from "@phosphor-icons/react";
import { fileLanguage, isMarkdownPath, pathParts } from "@ace/ui-core";
import { useConnectionState } from "@ace/client-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { keymap } from "@/lib/keymap.ts";
import type { FileContent } from "./checkout-source.ts";
import { SourceView, type FindHit } from "./source-view.tsx";
import { formatBytes } from "./use-file-actions.ts";

/** Lines of grey shaped like source while the file loads. */
function SourceSkeleton() {
  const widths = [62, 48, 0, 74, 81, 40, 0, 66, 58, 70, 35];
  return (
    <div
      role="status"
      aria-label="Loading the file"
      className="flex flex-col gap-[10px] py-3 pr-6 pl-[64px]"
    >
      {widths.map((width, index) =>
        width ? (
          <Skeleton
            key={index}
            className="h-3"
            style={{ width: `${width}%`, animationDelay: `${index * 60}ms` }}
          />
        ) : (
          <span key={index} className="h-3" />
        ),
      )}
    </div>
  );
}

/** An image file, drawn on the content background with its size underneath. */
function ImageView(props: { blob: Blob; name: string; size: number }) {
  const image = useRef<HTMLImageElement>(null);
  const [broken, setBroken] = useState(false);
  // The object URL lives exactly as long as this image shows this file.
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const url = URL.createObjectURL(props.blob);
    element.src = url;
    return () => URL.revokeObjectURL(url);
  }, [props.blob]);
  if (broken)
    return (
      <EmptyState
        icon={ImageBrokenIcon}
        title="This image can't be drawn"
        description={`${props.name} (${formatBytes(props.size)}) isn't an image this browser can show.`}
      />
    );
  return (
    <figure className="flex min-h-full flex-col items-center justify-center gap-3 p-8">
      <img
        ref={image}
        alt={props.name}
        onError={() => setBroken(true)}
        className="max-h-[70vh] max-w-full rounded-md object-contain shadow-[0_0_0_1px_var(--border)]"
      />
      <figcaption className="text-xs text-subtle-foreground tabular-nums">
        {formatBytes(props.size)}
      </figcaption>
    </figure>
  );
}

/**
 * What a file tab shows for its file: source with line numbers, rendered markdown, an image, or
 * a plain sentence saying why it can't be shown (binary, too large, gone, offline) with what to
 * do instead. The path stays in the toolbar above whatever happens here.
 */
export function FileViewer(props: {
  path: string;
  content: FileContent | undefined;
  error: Error | null;
  wrap: boolean;
  source: boolean;
  find: { query: string; hit: FindHit | undefined } | undefined;
  line: number | undefined;
  onRetry(): void;
  onDownload(): void;
  onFind(): void;
}) {
  const online = useConnectionState() === "ready";
  const name = pathParts(props.path).name;
  const content = props.content;
  if (!content) {
    if (!online)
      return (
        <EmptyState
          icon={WifiSlashIcon}
          title="The daemon is offline"
          description={`${name} loads once ace reconnects to the daemon.`}
        />
      );
    if (props.error)
      return (
        <div role="alert" className="h-full">
          <EmptyState
            icon={WarningCircleIcon}
            title={`Couldn't open ${name}`}
            description={props.error.message}
            action={
              <Button size="sm" variant="outline" onClick={props.onRetry}>
                Try again
              </Button>
            }
          />
        </div>
      );
    return <SourceSkeleton />;
  }
  const download = (
    <Button size="sm" variant="outline" onClick={props.onDownload}>
      <DownloadSimpleIcon aria-hidden size={14} />
      Download
    </Button>
  );
  switch (content.kind) {
    case "missing":
      return (
        <EmptyState
          icon={FileDashedIcon}
          title="Not in the checkout"
          description={`Nothing is at ${props.path} in this thread's checkout. It may have been moved or deleted.`}
          action={
            <Button size="sm" variant="outline" onClick={props.onFind}>
              <MagnifyingGlassIcon aria-hidden size={14} />
              Find it by name
            </Button>
          }
        />
      );
    case "large":
      return (
        <EmptyState
          icon={FileTextIcon}
          title="Too large to show here"
          description={`${name} is ${formatBytes(content.size)}. Files over 2 MB open as a download.`}
          action={download}
        />
      );
    case "binary":
      return (
        <EmptyState
          icon={FileIcon}
          title="Binary file"
          description={`${name} (${formatBytes(content.size)}) isn't text, so there's nothing to read here.`}
          action={download}
        />
      );
    case "image":
      return <ImageView blob={content.blob} name={name} size={content.size} />;
    case "text":
      if (isMarkdownPath(props.path) && !props.source)
        return (
          <article className="mx-auto w-full max-w-[760px] px-8 py-6 text-[14px] leading-[1.6]">
            <Prose text={content.text} />
          </article>
        );
      if (!content.text)
        return (
          <EmptyState
            icon={FileTextIcon}
            title="Empty file"
            description={`${name} has no content.`}
          />
        );
      return (
        <SourceView
          text={content.text}
          lang={fileLanguage(props.path)}
          wrap={props.wrap}
          find={props.find}
          line={props.line}
          label={`Source of ${props.path}`}
        />
      );
  }
}

/** The tab before a file is picked: say how to pick one. */
export function NoFile(props: { onSearch(): void; children?: ReactNode }) {
  return (
    <EmptyState
      icon={FileTextIcon}
      title="Open a file"
      description={
        <>
          Pick one from the tree, or press <Kbd keys={keymap.files.keys} /> to search the checkout.
        </>
      }
      action={
        <Button size="sm" variant="outline" onClick={props.onSearch}>
          <MagnifyingGlassIcon aria-hidden size={14} />
          Search files
        </Button>
      }
    />
  );
}
