import type { SpadeFileEntry } from "@ace/ui-core/spade-chat";
import { useEffect, useState } from "react";
import { fileIcon, folderIcon } from "@/components/file-icon.ts";
import { Icon } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { useSpadeClient } from "../spade-machine.tsx";
import { downloadFile } from "../spade-workspace-api.ts";

const picturePattern = /\.(png|jpe?g|gif|webp|svg)$/i;
/** A picture is drawn as its own thumbnail up to this size. */
const thumbBytes = 2_000_000;

/**
 * A small leading tile for a workspace file row: the image itself for a picture within the
 * size cap, otherwise a clean file-type or folder icon.
 */
export function FileThumb(props: {
  bot: string;
  entry: SpadeFileEntry;
  /** "tile" renders a subtle 24px rounded tile (Library); "icon" renders a bare 16px glyph unless image. */
  variant?: "tile" | "icon";
  className?: string;
}) {
  const client = useSpadeClient();
  const { bot, entry, variant = "icon" } = props;
  const [loaded, setLoaded] = useState<{ key: string; url: string }>();
  const picture =
    entry.kind === "file" && picturePattern.test(entry.name) && entry.size <= thumbBytes;
  const key = `${bot}\n${entry.path}\n${entry.modifiedAt ?? ""}`;

  useEffect(() => {
    if (!picture) return;
    let live = true;
    let made: string | undefined;
    downloadFile(client, bot, entry.path).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setLoaded({ key, url: made });
      },
      () => {},
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, bot, entry.path, picture, key]);

  const url = loaded?.key === key ? loaded.url : undefined;
  if (url) {
    return (
      <img
        alt=""
        src={url}
        className={cn(
          "size-6 shrink-0 rounded-sm bg-surface-2 object-cover shadow-[inset_0_0_0_1px_var(--border-soft)]",
          props.className,
        )}
      />
    );
  }
  const glyph = entry.kind === "folder" ? folderIcon(entry.path, false) : fileIcon(entry.path);
  if (variant === "tile") {
    return (
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-sm bg-hover text-muted-foreground",
          props.className,
        )}
      >
        <Icon icon={glyph} size={16} />
      </span>
    );
  }
  return (
    <Icon
      icon={glyph}
      size={16}
      className={cn("shrink-0 text-muted-foreground", props.className)}
    />
  );
}
