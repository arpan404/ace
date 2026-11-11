import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  textPreviewBytes,
  tooLargeToLoad,
  wholeBudget,
  wholeFileBytes,
} from "./attachment-content.ts";
import { EditableText } from "./attachment-edit.tsx";
import { FileGlyph } from "./attachment-face.tsx";
import type { FileSource, PreviewFile } from "./attachment-format.ts";
import {
  deliveryDetails,
  describeFile,
  fileMeta,
  formatLimit,
  type Described,
} from "./attachment-kind.ts";
import {
  FileMedia,
  isMediaMode,
  mediaType,
  useTextPrefix,
  useWholeUrl,
  type MediaMode,
} from "./file-media.tsx";
import { useSaveFile } from "./file-save.ts";
import { formatBytes } from "./format-bytes.ts";

/*
 * One file over the page, by kind: a PDF in the browser's own viewer, audio and video with
 * native controls, text and code as the first 64 KB in monospace (saying when there is more),
 * anything else as its details. Download saves it. Given `onSave`, a text file this device holds
 * opens editable instead. Loaded only when a chip is first opened.
 */

/** Frames and players take most of a short window, never more than the dialog allows. */
const stage = { height: "min(70dvh, 56rem)" };

export function AttachmentPreview(props: {
  file: PreviewFile;
  /** Save edited text in the file's place; the dialog closes after. */
  onSave?: ((text: string) => void) | undefined;
  onClose(): void;
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const { file, onSave } = props;
  const described = describeFile(file);
  const local = file.source?.kind === "file" ? file.source.file : undefined;
  const editable = onSave && local && described.preview === "text" ? local : undefined;
  const delivery = file.delivery ? deliveryDetails[file.delivery] : undefined;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        size="lg"
        finalFocus={props.finalFocus}
        style={
          described.preview === "none" ? undefined : { width: "min(960px, calc(100vw - 2rem))" }
        }
      >
        <DialogHeader>
          <DialogTitle className="truncate">{file.name}</DialogTitle>
          <DialogDescription>
            {fileMeta(file)}
            {delivery && ` · ${delivery}`}
          </DialogDescription>
        </DialogHeader>
        {editable && onSave ? (
          <EditableText
            file={editable}
            frame={stage}
            actions={<Download file={file} />}
            onSave={(text) => {
              onSave(text);
              props.onClose();
            }}
          />
        ) : (
          <>
            <Body file={file} described={described} />
            <DialogFooter>
              <Download file={file} />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body(props: { file: PreviewFile; described: Described }) {
  const { file, described } = props;
  const source = file.source;
  if (!source) return <Note kind={described.kind}>This file isn't readable from this device.</Note>;
  if (described.preview === "text") return <TextBody source={source} />;
  if (described.preview === "none")
    return (
      <Note kind={described.kind}>
        No preview for {described.label} files. Download it to open it in another app.
      </Note>
    );
  if (tooLargeToLoad(source))
    return (
      <Note kind={described.kind}>
        Previews here go up to {formatLimit(wholeBudget(source))}; this file is{" "}
        {formatBytes(source.bytes)}.
      </Note>
    );
  if (!isMediaMode(described.preview)) return null;
  return <MediaBody file={file} source={source} mode={described.preview} />;
}

/** A frame or player over the whole file, once its bytes are here. */
function MediaBody(props: { file: PreviewFile; source: FileSource; mode: MediaMode }) {
  const { mode } = props;
  const url = useWholeUrl(props.source, mediaType(mode));
  const [broken, setBroken] = useState(false);
  const kind = describeFile(props.file).kind;
  if (url.state === "loading") return <Skeleton className="w-full rounded-md" style={stage} />;
  if (url.state === "failed" && url.tooLarge)
    return <Note kind={kind}>Previews here go up to {formatLimit(wholeFileBytes)}.</Note>;
  if (url.state === "failed" || broken)
    return <Note kind={kind}>Couldn't load this file on this device.</Note>;
  return (
    <FileMedia
      url={url.value}
      name={props.file.name}
      mode={mode}
      frame={stage}
      onError={() => setBroken(true)}
    />
  );
}

/** The first 64 KB of a text file, monospace, saying so when the file goes on. */
function TextBody(props: { source: FileSource }) {
  const text = useTextPrefix(props.source);
  if (text.state === "loading") return <Skeleton className="h-40 w-full rounded-md" />;
  if (text.state === "failed")
    return <Note kind="text">Couldn't load this file on this device.</Note>;
  const { value } = text;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <pre
        role="region"
        tabIndex={0}
        aria-label="File contents"
        style={{ maxHeight: stage.height }}
        className="focus-ring min-h-0 overflow-auto rounded-md bg-code p-3 font-mono text-xs leading-5 whitespace-pre"
      >
        {value.text || " "}
      </pre>
      {value.truncated && (
        <p className="text-xs text-muted-foreground">
          Truncated: showing the first {textPreviewBytes / 1024} KB
          {value.total === undefined ? "" : ` of ${formatBytes(value.total)}`}.
        </p>
      )}
    </div>
  );
}

function Note(props: { kind: Described["kind"]; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
      <FileGlyph kind={props.kind} />
      <p className="max-w-80">{props.children}</p>
    </div>
  );
}

/** Saves the file under its own name; a sent file comes through the thread's connection. */
function Download(props: { file: PreviewFile }) {
  const { save, busy, off } = useSaveFile(props.file);
  return (
    <Button variant="secondary" disabled={off || busy} onClick={save}>
      <DownloadSimpleIcon aria-hidden size={14} />
      Download
    </Button>
  );
}
