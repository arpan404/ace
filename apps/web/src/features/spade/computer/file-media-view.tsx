import { useEffect, useState } from "react";
import { wholeFileBytes } from "@/components/attachment-content.ts";
import { describeFile } from "@/components/attachment-kind.ts";
import { FileMedia, isMediaMode, mediaType, type MediaMode } from "@/components/file-media.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useSpadeClient } from "../spade-machine.tsx";
import { downloadFile } from "../spade-workspace-api.ts";

/** The browser's own viewer for a file of the bot's by its name: a picture, a PDF, a player. */
export function mediaModeOf(path: string, size: number): MediaMode | undefined {
  const mode = describeFile({ name: path }).preview;
  return isMediaMode(mode) && size <= wholeFileBytes ? mode : undefined;
}

/**
 * A picture, PDF, recording or video of the bot's, read whole from Spade and drawn by the
 * browser's own viewer. Read again when its revision moves (the bot wrote it anew); the object
 * URL goes once the file stops showing.
 */
export function FileMediaView(props: {
  bot: string;
  path: string;
  mode: MediaMode;
  revision: string | undefined;
  /** Shown when the bytes can't be read or drawn. */
  fallback: React.ReactNode;
}) {
  const client = useSpadeClient();
  const { bot, path, mode, revision } = props;
  const [shown, setShown] = useState<{ key: string; url?: string; failed?: true }>();
  const key = `${bot}\n${path}\n${revision ?? ""}`;
  useEffect(() => {
    let live = true;
    let url: string | undefined;
    const type = mediaType(mode);
    downloadFile(client, bot, path).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
        setShown({ key, url });
      },
      () => live && setShown({ key, failed: true }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, bot, path, mode, key]);
  const now = shown?.key === key ? shown : undefined;
  if (now?.failed) return props.fallback;
  if (!now?.url)
    return (
      <LoadingRegion label="File" className="p-4">
        <Skeleton className="h-40 w-full rounded-md" />
      </LoadingRegion>
    );
  const name = path.split("/").at(-1) ?? path;
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-4">
      <FileMedia
        url={now.url}
        name={name}
        mode={mode}
        frame={{ height: "100%" }}
        onError={() => setShown({ key, failed: true })}
      />
    </div>
  );
}
