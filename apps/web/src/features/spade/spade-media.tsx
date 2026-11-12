import {
  spadeDocumentFacts,
  type SpadeDocumentRef,
  type SpadeImageRef,
  type SpadeVoiceRef,
} from "@ace/ui-core/spade-chat";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { holdSpadePicture, holdSpadeRecording } from "./spade-images.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { segment, spadeBlob } from "./spade-requests.ts";

/*
 * What a message carries besides words, in the chat (ADR 0134): pictures, documents and a voice
 * message's recording. Each is read from Spade by hash only when shown or asked for.
 */

/** Hand a file to the browser to save under `name`. */
function saveAs(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
}

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Pictures in a message, each read once and kept by hash: the person's right-aligned, the
 * bot's left-aligned with Save under each.
 */
export function Pictures(props: { images: readonly SpadeImageRef[]; side: "person" | "bot" }) {
  return (
    <div
      className={cn(
        "flex max-w-[80%] flex-wrap gap-1.5",
        props.side === "person" ? "justify-end" : "justify-start",
      )}
    >
      {/* The same image twice in one message is one picture shown twice: keyed by place. */}
      {props.images
        .map((image, place) => ({ image, key: `${place}:${image.sha256}` }))
        .map(({ image, key }) => (
          <Picture key={key} image={image} saves={props.side === "bot"} />
        ))}
    </div>
  );
}

function Picture(props: { image: SpadeImageRef; saves: boolean }) {
  const client = useSpadeClient();
  const hash = props.image.sha256;
  const [shown, setShown] = useState<{ hash: string; url?: string; failed?: true }>();
  useEffect(() => {
    let live = true;
    const picture = holdSpadePicture(client, hash);
    picture.url.then(
      (url) => live && setShown({ hash, url }),
      () => live && setShown({ hash, failed: true }),
    );
    return () => {
      live = false;
      picture.release();
    };
  }, [client, hash]);
  const state = shown?.hash === hash ? shown : undefined;
  const url = state?.url;
  if (url) {
    const image = <img src={url} alt="" className="max-h-40 max-w-60 rounded-lg object-cover" />;
    if (!props.saves) return image;
    const name = `image-${hash.slice(0, 8)}.${extensions[props.image.mediaType] ?? "png"}`;
    return (
      <figure className="flex flex-col items-start gap-0.5">
        {image}
        <Button size="xs" variant="ghost" className="-ml-2" onClick={() => saveAs(url, name)}>
          Save
        </Button>
      </figure>
    );
  }
  return (
    <span
      role={state?.failed ? "img" : undefined}
      aria-label={state?.failed ? "An image that couldn't be loaded" : undefined}
      aria-busy={state ? undefined : true}
      className="grid h-24 w-32 place-items-center rounded-lg bg-bubble text-xs text-muted-foreground"
    >
      {state?.failed ? "Image" : null}
    </span>
  );
}

/** Documents in a message: each a chip with its name, pages or sheets and size, Open and Download. */
export function DocumentChips(props: {
  documents: readonly SpadeDocumentRef[];
  side: "person" | "bot";
}) {
  return (
    <div
      className={cn(
        "flex max-w-[80%] flex-col gap-1.5",
        props.side === "person" ? "items-end" : "items-start",
      )}
    >
      {/* The same file twice in one message shows twice: keyed by place. */}
      {props.documents
        .map((document, place) => ({ document, key: `${place}:${document.sha256}` }))
        .map(({ document, key }) => (
          <DocumentChip key={key} document={document} />
        ))}
    </div>
  );
}

function DocumentChip(props: { document: SpadeDocumentRef }) {
  const client = useSpadeClient();
  const toast = useToast();
  const { document: file } = props;
  const [busy, setBusy] = useState<"open" | "download">();
  const facts = spadeDocumentFacts(file);
  const fetchFile = async (doing: "open" | "download") => {
    setBusy(doing);
    try {
      const path = `/v1/documents/${segment(file.sha256)}?name=${encodeURIComponent(file.name)}`;
      const blob = await spadeBlob(client, path);
      const url = URL.createObjectURL(blob);
      if (doing === "open") window.open(url, "_blank", "noopener");
      else saveAs(url, file.name);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast.error({
        title: doing === "open" ? `Couldn't open ${file.name}` : `Couldn't download ${file.name}`,
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div
      role="group"
      aria-label={file.name}
      className="flex max-w-full min-w-0 flex-col rounded-lg bg-bubble px-3 pt-2 pb-1 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <span className="truncate text-ui text-foreground">{file.name}</span>
      {facts && <span className="text-xs text-muted-foreground">{facts}</span>}
      <div className="-mx-2 mt-0.5 flex gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={busy !== undefined}
          onClick={() => void fetchFile("open")}
        >
          {busy === "open" ? "Opening…" : "Open"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy !== undefined}
          onClick={() => void fetchFile("download")}
        >
          {busy === "download" ? "Downloading…" : "Download"}
        </Button>
      </div>
    </div>
  );
}

/** A voice message's recording: Play and Pause, read from Spade on the first Play. */
export function VoicePlay(props: { voice: SpadeVoiceRef }) {
  const client = useSpadeClient();
  const toast = useToast();
  const audio = useRef<HTMLAudioElement>(null);
  const held = useRef<ReturnType<typeof holdSpadeRecording> | undefined>(undefined);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  useEffect(() => () => held.current?.release(), []);
  const toggle = async () => {
    const element = audio.current;
    if (!element) return;
    if (state === "playing") {
      element.pause();
      return;
    }
    setState("loading");
    try {
      held.current ??= holdSpadeRecording(client, props.voice.sha256);
      const url = await held.current.url;
      if (element.src !== url) element.src = url;
      await element.play();
    } catch (error) {
      setState("idle");
      toast.error({
        title: "Couldn't play the voice message",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the transcript is the bubble's words */}
      <audio
        ref={audio}
        hidden
        onPlaying={() => setState("playing")}
        onPause={() => setState("idle")}
        onEnded={() => setState("idle")}
      />
      <Button
        size="xs"
        variant="ghost"
        aria-label={state === "playing" ? "Pause voice message" : "Play voice message"}
        disabled={state === "loading"}
        onClick={() => void toggle()}
      >
        {state === "playing" ? "Pause" : "Play"}
      </Button>
    </>
  );
}
