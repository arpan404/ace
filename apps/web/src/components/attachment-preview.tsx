import { useClient } from "@ace/client-react";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
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
import { useToast } from "@/components/ui/toast.tsx";
import {
  readTextPrefix,
  readWhole,
  textPreviewBytes,
  tooLargeToLoad,
  wholePreviewBytes,
  type TextPrefix,
} from "./attachment-content.ts";
import { FileGlyph } from "./attachment-face.tsx";
import type { FileSource, PreviewFile } from "./attachment-format.ts";
import {
  deliveryDetails,
  describeFile,
  fileMeta,
  formatLimit,
  type Described,
} from "./attachment-kind.ts";
import { formatBytes } from "./format-bytes.ts";

/*
 * One file over the page, by kind: a PDF in the browser's own viewer, audio and video with
 * native controls, text and code as the first 64 KB in monospace (saying when there is more),
 * anything else as its details. Download saves it. Loaded only when a chip is first opened.
 */

type Loaded<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed" };
const loading = { state: "loading" } as const;

/** Frames and players take most of a short window, never more than the dialog allows. */
const stage = { height: "min(70dvh, 56rem)" };

export function AttachmentPreview(props: {
  file: PreviewFile;
  onClose(): void;
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const { file } = props;
  const described = describeFile(file);
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
        <Body file={file} described={described} />
        <DialogFooter>
          <Download file={file} />
        </DialogFooter>
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
        Previews here go up to {formatLimit(wholePreviewBytes)}; this file is{" "}
        {formatBytes(source.bytes)}.
      </Note>
    );
  return <MediaBody file={file} source={source} described={described} />;
}

/** A frame or player over the whole file, once its bytes are here. */
function MediaBody(props: { file: PreviewFile; source: FileSource; described: Described }) {
  const { described } = props;
  // A PDF frame shows the viewer only for a blob typed as a PDF.
  const type = described.preview === "pdf" ? "application/pdf" : undefined;
  const url = useWholeUrl(props.source, type);
  const [broken, setBroken] = useState(false);
  if (url.state === "loading") return <Skeleton className="w-full rounded-md" style={stage} />;
  if (url.state === "failed" || broken)
    return <Note kind={described.kind}>Couldn't load this file on this device.</Note>;
  const name = props.file.name;
  if (described.preview === "pdf")
    return (
      // The frame only ever holds a blob this page typed as a PDF, so it is the browser's own
      // viewer; a sandbox would stop that viewer from drawing at all.
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        title={name}
        src={url.value}
        style={stage}
        className="w-full rounded-md border border-border bg-background"
      />
    );
  if (described.preview === "audio")
    return (
      <audio
        controls
        src={url.value}
        aria-label={name}
        className="w-full"
        onError={() => setBroken(true)}
      />
    );
  if (described.preview === "video")
    return (
      <video
        controls
        src={url.value}
        aria-label={name}
        style={{ maxHeight: stage.height }}
        className="w-full rounded-md bg-background"
        onError={() => setBroken(true)}
      />
    );
  return (
    <img
      src={url.value}
      alt={name}
      style={{ maxHeight: stage.height }}
      className="mx-auto max-w-full rounded-md object-contain"
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
        tabIndex={0}
        aria-label="File contents"
        style={{ maxHeight: stage.height }}
        className="focus-ring min-h-0 overflow-auto rounded-md bg-code p-3 font-mono text-xs leading-5 whitespace-pre"
      >
        {value.text || " "}
      </pre>
      {value.truncated && (
        <p className="text-xs text-muted-foreground">
          Truncated: showing the first {textPreviewBytes / 1024} KB of {formatBytes(value.total)}.
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
  const client = useClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const source = props.file.source;
  const off = !source || tooLargeToLoad(source);
  const save = () => {
    if (!source || off) return;
    setBusy(true);
    readWhole(client, source, undefined, new AbortController().signal)
      .then(
        (blob) => {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = props.file.name;
          link.click();
          // The download holds the bytes once it starts; the URL can go after that.
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
        () => toast.add({ title: "Couldn't download the file" }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Button variant="secondary" disabled={off || busy} onClick={save}>
      <DownloadSimpleIcon aria-hidden size={14} />
      Download
    </Button>
  );
}

function useWholeUrl(source: FileSource, type: string | undefined): Loaded<string> {
  const client = useClient();
  const [loaded, setLoaded] = useState<{ source: FileSource; value: Loaded<string> }>();
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    readWhole(client, source, type, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLoaded({ source, value: { state: "ready", value: url } });
      },
      () => {
        if (!abort.signal.aborted) setLoaded({ source, value: { state: "failed" } });
      },
    );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, source, type]);
  return loaded?.source === source ? loaded.value : loading;
}

function useTextPrefix(source: FileSource): Loaded<TextPrefix> {
  const client = useClient();
  const [loaded, setLoaded] = useState<{ source: FileSource; value: Loaded<TextPrefix> }>();
  useEffect(() => {
    const abort = new AbortController();
    readTextPrefix(client, source, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setLoaded({ source, value: { state: "ready", value } });
      },
      () => {
        if (!abort.signal.aborted) setLoaded({ source, value: { state: "failed" } });
      },
    );
    return () => abort.abort();
  }, [client, source]);
  return loaded?.source === source ? loaded.value : loading;
}
