import {
  FileAudioIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FileTextIcon,
  FileVideoIcon,
  FileZipIcon,
} from "@phosphor-icons/react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { splitName, type FileKind } from "./attachment-kind.ts";

/*
 * The parts every attachment chip shares, in the composer and the transcript: a glyph by kind
 * in its own ink (never a wash behind it) and a name whose middle gives way first, so the
 * extension stays readable at any width.
 */

const glyphs: Record<FileKind, IconGlyph> = {
  image: FileImageIcon,
  pdf: FilePdfIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  sheet: FileCsvIcon,
  archive: FileZipIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  binary: FileIcon,
};

/** Each kind's ink, from the theme's status palette, which every preset keeps legible. */
const inks: Record<FileKind, string> = {
  image: "var(--status-working)",
  pdf: "var(--status-failed)",
  code: "var(--status-working)",
  text: "var(--muted-foreground)",
  sheet: "var(--status-done)",
  archive: "var(--status-needs-you)",
  audio: "var(--status-waiting)",
  video: "var(--status-unresponsive)",
  binary: "var(--subtle-foreground)",
};

/** The kind's glyph in its ink, centred in a 24 px square (20 inside an upload ring). */
export function FileGlyph(props: { kind: FileKind; className?: string | undefined }) {
  return (
    <span
      style={{ color: inks[props.kind] }}
      className={cn("grid size-6 shrink-0 place-items-center", props.className)}
    >
      <Icon icon={glyphs[props.kind]} size={14} />
    </span>
  );
}

/** A file name on one line: a long one loses its middle, never its extension. */
export function FileName(props: { name: string }) {
  const [head, tail] = splitName(props.name);
  if (!tail) return <span className="min-w-0 truncate">{props.name}</span>;
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  );
}
