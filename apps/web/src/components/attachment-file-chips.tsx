import { useState } from "react";
import { FileIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { FileName, kindGlyph } from "./attachment-face.tsx";
import type { ShownFile } from "./attachment-format.ts";
import { deliveryDetails, deliveryLabels, describeFile, fileMeta } from "./attachment-kind.ts";

/*
 * A message's files as compact chips: the file type's mark and its name. The size, type and how
 * the agent received it live in the tooltip and the accessible name, so a row of chips stays one
 * quiet line. Past six, a "+N files" chip shows the rest.
 */

/** Chips shown before the rest fold behind "+N files". */
export const shownFileChips = 6;

const chip =
  "flex h-6 max-w-full min-w-0 items-center gap-1 rounded-sm bg-surface-2 pr-2 pl-1.5 text-xs text-foreground";

export function FileChips(props: {
  files: readonly ShownFile[];
  onOpen?: ((file: ShownFile, element: HTMLElement) => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const folded = !all && props.files.length > shownFileChips;
  const shown = folded ? props.files.slice(0, shownFileChips) : props.files;
  return (
    <ul aria-label="Attached files" className="flex max-w-full flex-wrap justify-end gap-1">
      {shown.map((file) => (
        <li key={file.key} className="max-w-full min-w-0">
          <FileChip file={file} onOpen={props.onOpen} />
        </li>
      ))}
      {folded && (
        <li>
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setAll(true)}
            className={cn(
              chip,
              "focus-ring pl-2 text-muted-foreground tabular-nums transition-colors duration-(--motion-fast) hover:bg-accent hover:text-foreground",
            )}
          >
            +{props.files.length - shownFileChips} files
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * A sent file: its type's mark and name; size, type and delivery in the tooltip. A file this
 * device can read opens its preview; one an agent only named by path is a quiet label.
 */
export function FileChip(props: {
  file: ShownFile;
  onOpen?: ((file: ShownFile, element: HTMLElement) => void) | undefined;
}) {
  const { file } = props;
  const meta = fileMeta(file) + (file.delivery ? ` · ${deliveryLabels[file.delivery]}` : "");
  const byName = fileIcon(file.name);
  const glyph = byName === FileIcon ? kindGlyph(describeFile(file).kind) : byName;
  const tip = (
    <>
      <span className="block tabular-nums">{meta}</span>
      {file.delivery && (
        <span className="block text-muted-foreground">{deliveryDetails[file.delivery]}</span>
      )}
    </>
  );
  const face = (
    <>
      <Icon icon={glyph} size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex max-w-full min-w-0">
        <FileName name={file.name} />
      </span>
    </>
  );
  const onOpen = props.onOpen;
  return (
    <Tip label={tip}>
      {file.source && onOpen ? (
        <button
          type="button"
          aria-label={`${file.name}, ${meta}`}
          onClick={(event) => onOpen(file, event.currentTarget)}
          className={cn(
            chip,
            "focus-ring text-left transition-colors duration-(--motion-fast) hover:bg-accent",
          )}
        >
          {face}
        </button>
      ) : (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
        <span tabIndex={0} aria-label={`${file.name}, ${meta}`} className={cn(chip, "focus-ring")}>
          {face}
        </span>
      )}
    </Tip>
  );
}
