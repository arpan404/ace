import type { SpadeDocumentRef } from "@ace/ui-core/spade-chat";
import { useEffect, useState } from "react";
import { describeFile, extensionOf, type FileKind } from "@/components/attachment-kind.ts";
import { cn } from "@/lib/cn.ts";
import { spadeDocumentPath } from "./computer/document-reader.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { segment, spadeBlob, spadeHttp } from "./spade-requests.ts";

/*
 * A document's thumbnail in its chat card. The browser's own PDF viewer draws the reader, so
 * there is no page image to take: a PDF, a note or code shows the first lines Spade read from it
 * in tiny type on a page, a spreadsheet a mini table, a picture itself. Anything else, or a file
 * nothing could be read from, is a tile in its type's colour with its extension.
 */

type Tone = { ink: string; wash: string };

const tones = {
  pdf: { ink: "hsl(2 75% 62%)", wash: "hsl(2 75% 62% / 0.16)" },
  sheet: { ink: "hsl(145 50% 50%)", wash: "hsl(145 50% 50% / 0.16)" },
  doc: { ink: "hsl(215 80% 65%)", wash: "hsl(215 80% 65% / 0.16)" },
  markdown: { ink: "hsl(220 8% 62%)", wash: "hsl(220 8% 62% / 0.16)" },
  code: { ink: "hsl(270 60% 68%)", wash: "hsl(270 60% 68% / 0.16)" },
  archive: { ink: "hsl(30 45% 50%)", wash: "hsl(30 45% 50% / 0.18)" },
  other: { ink: "hsl(220 10% 60%)", wash: "hsl(220 10% 60% / 0.14)" },
} satisfies Record<string, Tone>;

const wordExts = new Set(["doc", "docx", "odt", "rtf", "pages"]);

/** A type's ink toward the theme's text colour, so its mark reads on a light page and a dark one. */
const inkOn = (tone: Tone) => `color-mix(in oklab, ${tone.ink} 55%, var(--foreground))`;

/** The colour and mark a document type wears; each type has its own, never one for all. */
export function documentTone(name: string, kind: FileKind): { tone: Tone; mark: string } {
  const ext = extensionOf(name);
  const mark = (ext || "file").slice(0, 4).toUpperCase();
  if (kind === "pdf") return { tone: tones.pdf, mark };
  if (kind === "sheet") return { tone: tones.sheet, mark };
  if (kind === "archive") return { tone: tones.archive, mark };
  if (kind === "code") return { tone: tones.code, mark };
  if (ext === "md" || ext === "mdx" || ext === "markdown") return { tone: tones.markdown, mark };
  if (wordExts.has(ext)) return { tone: tones.doc, mark };
  return { tone: tones.other, mark };
}

type Preview =
  | { kind: "image"; url: string }
  | { kind: "text"; lines: string[] }
  | { kind: "table"; rows: string[][] };

const previews = new Map<string, Promise<Preview | undefined>>();

async function extractedLines(client: Parameters<typeof spadeHttp>[0], sha256: string) {
  const answer: unknown = JSON.parse(
    await spadeHttp(client, "GET", `/v1/documents/${segment(sha256)}/text`),
  );
  const text =
    answer && typeof answer === "object" && "text" in answer && typeof answer.text === "string"
      ? answer.text
      : "";
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function load(client: Parameters<typeof spadeHttp>[0], doc: SpadeDocumentRef, kind: FileKind) {
  const key = `${doc.sha256}:${doc.name}`;
  const known = previews.get(key);
  if (known) return known;
  const made = (async (): Promise<Preview | undefined> => {
    if (kind === "image")
      return {
        kind: "image",
        url: URL.createObjectURL(await spadeBlob(client, spadeDocumentPath(doc))),
      };
    // Archives and unknown binaries have no text to show: their tile is the preview.
    if (kind === "archive" || kind === "audio" || kind === "video") return undefined;
    if (kind === "binary" && !wordExts.has(extensionOf(doc.name))) return undefined;
    const lines = await extractedLines(client, doc.sha256);
    if (lines.length === 0) return undefined;
    if (kind === "sheet")
      return {
        kind: "table",
        rows: lines.slice(0, 4).map((line) => line.split(/[,\t]/).slice(0, 3)),
      };
    return { kind: "text", lines };
  })().catch(() => undefined);
  previews.set(key, made);
  return made;
}

/** The 40px tile at the left of a document card. */
export function DocumentThumb(props: { document: SpadeDocumentRef; className?: string }) {
  const client = useSpadeClient();
  const { document: doc } = props;
  const { kind } = describeFile({ name: doc.name, mimeType: doc.mediaType });
  const { tone, mark } = documentTone(doc.name, kind);
  const [shown, setShown] = useState<{ key: string; preview: Preview | undefined }>();
  const key = `${doc.sha256}:${doc.name}`;
  useEffect(() => {
    let live = true;
    void load(client, doc, kind).then((preview) => live && setShown({ key, preview }));
    return () => {
      live = false;
    };
  }, [client, doc, kind, key]);
  const preview = shown?.key === key ? shown.preview : undefined;
  const frame = cn("relative size-10 shrink-0 overflow-hidden rounded-lg", props.className);
  if (preview?.kind === "image")
    return <img src={preview.url} alt="" className={cn(frame, "object-cover")} />;
  if (preview?.kind === "text")
    return (
      <span
        aria-hidden
        className={cn(
          frame,
          "bg-surface-1 px-1 pt-1 text-left font-sans text-[3.5px] leading-[5px] break-all text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-soft)]",
        )}
      >
        {preview.lines.slice(0, 7).map((line, place) => (
          // Lines repeat; their place is their identity.
          // eslint-disable-next-line react/no-array-index-key
          <span key={place} className="block truncate">
            {line}
          </span>
        ))}
        <TypeBadge mark={mark} tone={tone} />
      </span>
    );
  if (preview?.kind === "table")
    return (
      <span
        aria-hidden
        className={cn(
          frame,
          "grid content-start gap-px bg-surface-1 p-0.5 shadow-[inset_0_0_0_1px_var(--border-soft)]",
        )}
      >
        {preview.rows.map((row, place) => (
          // eslint-disable-next-line react/no-array-index-key
          <span key={place} className="grid grid-cols-3 gap-px">
            {[0, 1, 2].map((col) => (
              <span
                key={col}
                className={cn(
                  "h-[5px] truncate text-[3px] leading-[5px] text-muted-foreground",
                  place === 0 ? "font-semibold" : "",
                )}
                style={{ background: place === 0 ? tone.wash : "var(--hover)" }}
              >
                {row[col]}
              </span>
            ))}
          </span>
        ))}
        <TypeBadge mark={mark} tone={tone} />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cn(frame, "grid place-items-center text-[11px] font-bold tracking-wide")}
      style={{ background: tone.wash, color: inkOn(tone) }}
    >
      {mark}
    </span>
  );
}

function TypeBadge(props: { mark: string; tone: Tone }) {
  return (
    <span
      className="absolute right-0 bottom-0 rounded-tl bg-surface-1 px-1 text-[6px] leading-[9px] font-bold"
      style={{ color: inkOn(props.tone), boxShadow: `inset 0 0 0 9px ${props.tone.wash}` }}
    >
      {props.mark}
    </span>
  );
}
