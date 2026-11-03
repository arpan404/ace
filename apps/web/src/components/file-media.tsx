import { useClient } from "@ace/client-react";
import { useEffect, useState, type CSSProperties } from "react";
import {
  readTextPrefix,
  readWhole,
  TooLargeToLoad,
  type TextPrefix,
} from "./attachment-content.ts";
import type { FileSource } from "./attachment-format.ts";
import type { MediaMode } from "./file-media-mode.ts";

export { isMediaMode, mediaType, type MediaMode } from "./file-media-mode.ts";

/*
 * A file drawn by the browser's own viewers: a PDF in its PDF viewer, audio and video with
 * native controls, an image as itself. Shared by the preview dialog, the side panel's file
 * tab and the Files tool, so a file looks and plays the same wherever it opens. The hooks load
 * a file's bytes through the thread's connection and keep one object URL per shown file.
 */

export function FileMedia(props: {
  url: string;
  name: string;
  mode: MediaMode;
  /** The frame's and players' box: a fixed height in a dialog, the whole panel in a tab. */
  frame: CSSProperties;
  onError(): void;
}) {
  const { url, name, frame } = props;
  if (props.mode === "pdf")
    return (
      // The frame only ever holds a blob this page typed as a PDF, so it is the browser's own
      // viewer; a sandbox would stop that viewer from drawing at all.
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        title={name}
        src={url}
        style={frame}
        className="w-full rounded-md border border-border bg-background"
      />
    );
  if (props.mode === "audio")
    return (
      <audio controls src={url} aria-label={name} className="w-full" onError={props.onError} />
    );
  if (props.mode === "video")
    return (
      <video
        controls
        playsInline
        src={url}
        aria-label={name}
        style={{ maxHeight: frame.height }}
        className="w-full rounded-md bg-background"
        onError={props.onError}
      />
    );
  return (
    <img
      src={url}
      alt={name}
      style={{ maxHeight: frame.height }}
      className="mx-auto max-w-full rounded-md object-contain"
      onError={props.onError}
    />
  );
}

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "failed"; tooLarge: boolean };
const loading = { state: "loading" } as const;
const failed = (error: unknown) => ({
  state: "failed" as const,
  tooLarge: error instanceof TooLargeToLoad,
});

/** An object URL over the whole file, typed `type`; revoked once the file stops showing. */
export function useWholeUrl(source: FileSource, type: string | undefined): Loaded<string> {
  const client = useClient();
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    source: FileSource;
    value: Loaded<string>;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    readWhole(client, source, type, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLoaded({ client, source, value: { state: "ready", value: url } });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setLoaded({ client, source, value: failed(error) });
      },
    );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, source, type]);
  return loaded?.client === client && loaded.source === source ? loaded.value : loading;
}

/** The first `limit` bytes of a file as text. */
export function useTextPrefix(source: FileSource, limit?: number): Loaded<TextPrefix> {
  const client = useClient();
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    source: FileSource;
    value: Loaded<TextPrefix>;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    readTextPrefix(client, source, abort.signal, limit).then(
      (value) => {
        if (!abort.signal.aborted) setLoaded({ client, source, value: { state: "ready", value } });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setLoaded({ client, source, value: failed(error) });
      },
    );
    return () => abort.abort();
  }, [client, source, limit]);
  return loaded?.client === client && loaded.source === source ? loaded.value : loading;
}
