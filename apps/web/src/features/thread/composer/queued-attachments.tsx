import type { Attachment, MessageContext } from "@ace/protocol";
import { useState } from "react";
import { ImageUrl } from "@/components/attachment-bytes.tsx";
import { FileGlyph, FileName } from "@/components/attachment-face.tsx";
import { describeFile } from "@/components/attachment-kind.ts";
import { useFilePreview, useLightbox } from "@/components/attachment-open.tsx";
import type { ShownImage } from "@/components/attachment-format.ts";
import { localAttachment } from "./send-store.ts";

/** Compact previews keep the queue's file context visible after reloads, edits and moves. */
export function QueuedAttachments(props: {
  threadId: string;
  context: MessageContext | undefined;
  metadata: readonly Attachment[];
}) {
  const [expanded, setExpanded] = useState(false);
  const files = (props.context?.attachments ?? []).map(({ sha256 }) => {
    const stored = props.metadata.find((file) => file.sha256 === sha256);
    const local = localAttachment(sha256);
    return {
      sha256,
      name: stored?.name ?? local?.name ?? "Attached file",
      mimeType: stored?.mimeType ?? local?.mimeType,
      bytes: stored?.bytes ?? local?.bytes ?? 0,
      kind: stored?.kind,
      source: local?.previewUrl
        ? ({ kind: "url", url: local.previewUrl } as const)
        : ({
            kind: "attachment",
            threadId: props.threadId,
            sha256,
            bytes: stored?.bytes ?? 0,
            thumbnail: stored?.thumbnailAvailable === true,
          } as const),
    };
  });
  const images = files.flatMap((file): ShownImage[] =>
    describeFile(file).kind === "image"
      ? [{ key: file.sha256, name: file.name, bytes: file.bytes, source: file.source }]
      : [],
  );
  const { show, lightbox } = useLightbox(images);
  const { show: showFile, preview } = useFilePreview();
  if (!files.length) return null;
  const shown = expanded ? files : files.slice(0, 3);
  return (
    <>
      <div
        role="group"
        aria-label="Queued attachments"
        className="flex min-w-0 flex-wrap gap-1.5 pt-1"
      >
        {shown.map((file) => {
          const image = images.findIndex((item) => item.key === file.sha256);
          return (
            <span key={file.sha256} className="min-w-0 max-w-44">
              <button
                type="button"
                aria-label={`Preview ${file.name}`}
                onClick={(event) =>
                  image >= 0
                    ? show(image, event.currentTarget)
                    : showFile(
                        {
                          ...file,
                          source: {
                            kind: "attachment",
                            threadId: props.threadId,
                            sha256: file.sha256,
                            bytes: file.bytes,
                          },
                        },
                        event.currentTarget,
                      )
                }
                className="focus-ring flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-background/50 pr-2 text-xs"
              >
                {image >= 0 ? (
                  <ImageUrl source={file.source}>
                    {(url) => (
                      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
                        {url.state === "ready" ? (
                          <img src={url.url} alt={file.name} className="size-full object-cover" />
                        ) : (
                          <FileGlyph kind="image" />
                        )}
                      </span>
                    )}
                  </ImageUrl>
                ) : (
                  <FileGlyph kind={describeFile(file).kind} />
                )}
                <FileName name={file.name} />
              </button>
            </span>
          );
        })}
        {!expanded && files.length > shown.length && (
          <span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="focus-ring rounded-sm px-1 text-xs hover:text-foreground"
            >
              Show {files.length - shown.length} more files
            </button>
          </span>
        )}
      </div>
      {lightbox}
      {preview}
    </>
  );
}
