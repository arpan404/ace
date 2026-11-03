import { DownloadSimpleIcon, FileIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { checkoutViewLimit, fileLanguage, isMarkdownPath } from "@ace/ui-core";
import { useMemo, useState } from "react";
import { wholeBudget, tooLargeToLoad } from "@/components/attachment-content.ts";
import type { FileSource, PreviewFile } from "@/components/attachment-format.ts";
import { describeFile, formatLimit } from "@/components/attachment-kind.ts";
import {
  FileMedia,
  isMediaMode,
  mediaType,
  useTextPrefix,
  useWholeUrl,
  type MediaMode,
} from "@/components/file-media.tsx";
import { useSaveFile } from "@/components/file-save.ts";
import { formatBytes } from "@/components/format-bytes.ts";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  filePreviewTabData,
  type FilePreviewTabData,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { SourceView } from "./source-view.tsx";

/*
 * A file outside the checkout, in the side panel: a PDF in the browser's viewer, video and audio
 * in its players, an image, text as highlighted source (markdown rendered), anything else as
 * its details with Download. Bytes come through the thread's connection, local or relayed.
 */

/** Fills the panel; players and images keep inside it. */
const frame = { height: "100%" };

function previewFile(data: FilePreviewTabData): PreviewFile {
  return {
    name: data.name,
    mimeType: data.mimeType,
    kind: data.kind,
    bytes: data.bytes,
    source: data.source,
  };
}

/** The tab's file, stable while its data is: the loaders key their reads on the source. */
function useTabFile(props: TabViewProps): PreviewFile | undefined {
  const { tab } = props;
  return useMemo(() => {
    const data = filePreviewTabData(tab);
    return data ? previewFile(data) : undefined;
  }, [tab]);
}

export default function FilePreviewTab(props: TabViewProps) {
  const file = useTabFile(props);
  if (!file?.source)
    return (
      <EmptyState
        icon={WarningCircleIcon}
        title="This file can't open"
        description="Open it again from the conversation."
      />
    );
  return (
    <section aria-label={file.name} className="flex h-full min-h-0 flex-col bg-background">
      <h2 className="sr-only">{file.name}</h2>
      <Body file={file} source={file.source} />
    </section>
  );
}

function Body(props: { file: PreviewFile; source: FileSource }) {
  const { file, source } = props;
  const described = describeFile(file);
  const download = <SaveButton file={file} />;
  if (described.preview === "text") return <TextBody file={file} source={source} />;
  if (!isMediaMode(described.preview))
    return (
      <EmptyState
        icon={FileIcon}
        title={file.name}
        description={`${described.label} files don't open here. Download it to open it in another app.`}
        action={download}
      />
    );
  if (tooLargeToLoad(source))
    return (
      <EmptyState
        icon={FileIcon}
        title="Too large to show here"
        description={`${file.name} is ${formatBytes(source.bytes)}; files up to ${formatLimit(wholeBudget(source))} open here.`}
        action={download}
      />
    );
  return <MediaBody file={file} source={source} mode={described.preview} />;
}

function MediaBody(props: { file: PreviewFile; source: FileSource; mode: MediaMode }) {
  const { file, mode } = props;
  const url = useWholeUrl(props.source, mediaType(mode));
  const [broken, setBroken] = useState(false);
  if (url.state === "loading")
    return (
      <div role="status" aria-label={`Loading ${file.name}`} className="h-full p-3">
        <Skeleton className="h-full w-full rounded-md" />
      </div>
    );
  if (url.state === "failed" || broken)
    return (
      <EmptyState
        icon={WarningCircleIcon}
        title={
          url.state === "failed" && url.tooLarge
            ? "Too large to show here"
            : `Couldn't open ${file.name}`
        }
        description={
          url.state === "failed" && url.tooLarge
            ? `Files up to ${formatLimit(wholeBudget(props.source))} open here.`
            : "Check that the file is still there, then try again."
        }
        action={<SaveButton file={file} />}
      />
    );
  // A frame fills the panel; players and images sit centred in it.
  const fill = mode === "pdf";
  return (
    <div
      className={
        fill
          ? "min-h-0 flex-1 p-2"
          : "flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
      }
    >
      <FileMedia
        url={url.value}
        name={file.name}
        mode={mode}
        frame={frame}
        onError={() => setBroken(true)}
      />
    </div>
  );
}

/** Text as the Files tool shows it: highlighted source, or markdown rendered. */
function TextBody(props: { file: PreviewFile; source: FileSource }) {
  const { file } = props;
  const text = useTextPrefix(props.source, checkoutViewLimit);
  if (text.state === "loading")
    return (
      <div role="status" aria-label={`Loading ${file.name}`} className="flex flex-col gap-2.5 p-4">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
  if (text.state === "failed")
    return (
      <EmptyState
        icon={WarningCircleIcon}
        title={`Couldn't open ${file.name}`}
        description="Check that the file is still there, then try again."
        action={<SaveButton file={file} />}
      />
    );
  const { value } = text;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {isMarkdownPath(file.name) ? (
          <article className="mx-auto w-full max-w-[760px] px-8 py-6 text-base leading-[1.6]">
            <Prose text={value.text} />
          </article>
        ) : (
          <SourceView
            text={value.text}
            lang={fileLanguage(file.name)}
            wrap={false}
            label={`Contents of ${file.name}`}
          />
        )}
      </div>
      {value.truncated && (
        <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          Showing the first {formatLimit(checkoutViewLimit)}
          {value.total === undefined ? "" : ` of ${formatBytes(value.total)}`}. Download it for the
          rest.
        </p>
      )}
    </div>
  );
}

function SaveButton(props: { file: PreviewFile }) {
  const { save, busy, off } = useSaveFile(props.file);
  return (
    <Button size="sm" variant="secondary" disabled={off || busy} onClick={save}>
      <DownloadSimpleIcon aria-hidden size={14} />
      Download
    </Button>
  );
}

/** The strip's Download while a file shows. */
export function Actions(props: TabViewProps) {
  const file = useTabFile(props);
  if (!file) return null;
  return <StripDownload file={file} />;
}

function StripDownload(props: { file: PreviewFile }) {
  const { save, busy, off } = useSaveFile(props.file);
  return (
    <IconButton
      size="sm"
      className="size-7"
      icon={DownloadSimpleIcon}
      label={`Download ${props.file.name}`}
      disabled={off || busy}
      onClick={save}
    />
  );
}
