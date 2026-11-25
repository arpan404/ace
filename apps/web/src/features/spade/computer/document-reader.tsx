import { spadeDocumentFacts, type SpadeDocumentRef } from "@ace/ui-core/spade-chat";
import { ArrowsInSimpleIcon, DotsThreeIcon, DownloadSimpleIcon } from "@ace/icons";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { describeFile, extensionOf } from "@/components/attachment-kind.ts";
import { fileIcon } from "@/components/file-icon.ts";
import { FileMedia, isMediaMode, mediaType } from "@/components/file-media.tsx";
import { formatBytes } from "@/components/format-bytes.ts";
import { Icon } from "@/components/icon.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { saveAs } from "../save-as.ts";
import { useSpadeClient } from "../spade-machine.tsx";
import { PanelSurfaceHeader, roundButton } from "../spade-profile-parts.tsx";
import { segment, spadeBlob, spadeHttp } from "../spade-requests.ts";

const isMarkdownDoc = (doc: SpadeDocumentRef) => {
  const ext = extensionOf(doc.name);
  return ext === "md" || ext === "mdx" || ext === "markdown" || doc.mediaType === "text/markdown";
};

export const spadeDocumentPath = (doc: SpadeDocumentRef) =>
  `/v1/documents/${segment(doc.sha256)}?name=${encodeURIComponent(doc.name)}`;

/** The text Spade extracted from a document, if it has any. */
async function extractedText(client: Parameters<typeof spadeHttp>[0], sha256: string) {
  try {
    const parsed: unknown = JSON.parse(
      await spadeHttp(client, "GET", `/v1/documents/${segment(sha256)}/text`),
    );
    if (parsed && typeof parsed === "object" && "text" in parsed) {
      const raw = parsed.text;
      if (typeof raw === "string" && raw.trim()) return raw;
    }
  } catch {
    // No extracted text is fine.
  }
  return undefined;
}

interface LoadedDocument {
  key: string;
  url?: string;
  text?: string;
  failed?: true;
}

/**
 * Clean reader for a chat document attachment opened in the side panel (or full screen):
 * markdown renders as formatted prose by default with Preview/Source in the overflow menu,
 * PDFs fill the full frame, and text/code reads cleanly with no extra toolbars or chrome.
 */
export function DocumentReader(props: { document: SpadeDocumentRef; onBack(): void }) {
  const { document: doc } = props;
  const client = useSpadeClient();
  const toast = useToast();
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const [fullscreen, setFullscreen] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [loaded, setLoaded] = useState<LoadedDocument>();

  const info = describeFile({ name: doc.name, mimeType: doc.mediaType });
  const markdown = isMarkdownDoc(doc);
  // "PDF · 6 pages · 2.5 MB", in the options menu rather than a bar over the file.
  const facts = [info.label, spadeDocumentFacts(doc)].filter(Boolean).join(" · ");
  const mediaMode = isMediaMode(info.preview) ? info.preview : undefined;
  const key = `${doc.sha256}\n${doc.name}`;

  useEffect(() => {
    let live = true;
    let objectUrl: string | undefined;
    const path = spadeDocumentPath(doc);

    const load = async () => {
      try {
        if (mediaMode) {
          const blob = await spadeBlob(client, path);
          if (!live) return;
          const type = mediaType(mediaMode) ?? doc.mediaType;
          objectUrl = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
          // Also fetch extracted text quietly for PDFs as a clean fallback if iframe fails.
          const extracted =
            mediaMode === "pdf" ? await extractedText(client, doc.sha256) : undefined;
          if (!live) return;
          setLoaded({ key, url: objectUrl, ...(extracted ? { text: extracted } : {}) });
          return;
        }
        if (info.preview === "text") {
          const blob = await spadeBlob(client, path);
          const text = await blob.text();
          if (!live) return;
          setLoaded({ key, text });
          return;
        }
        const extracted = await extractedText(client, doc.sha256);
        if (!live) return;
        setLoaded({ key, ...(extracted ? { text: extracted } : {}) });
      } catch {
        if (live) setLoaded({ key, failed: true });
      }
    };

    void load();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, doc, info.preview, mediaMode, key]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  const current = loaded?.key === key ? loaded : undefined;

  const download = async () => {
    try {
      const blob = await spadeBlob(client, spadeDocumentPath(doc));
      saveAs(blob, doc.name);
    } catch {
      toast.error({ title: `Couldn't download ${doc.name}` });
    }
  };

  const overflow = (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={DotsThreeIcon}
            label="File options"
            tip="More"
            size="default"
            className={roundButton}
          />
        }
      />
      <MenuContent align="end">
        {facts && (
          <>
            <MenuGroup>
              <MenuLabel>{facts}</MenuLabel>
            </MenuGroup>
            <MenuSeparator />
          </>
        )}
        {markdown && (
          <>
            <MenuRadioGroup
              value={markdownMode}
              onValueChange={(value) => {
                if (value === "preview" || value === "source") setMarkdownMode(value);
              }}
            >
              <MenuRadioItem value="preview">Preview</MenuRadioItem>
              <MenuRadioItem value="source">Source</MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        )}
        <MenuItem onClick={() => void download()}>
          <Icon icon={DownloadSimpleIcon} size={16} className="text-muted-foreground" />
          Download
        </MenuItem>
      </MenuContent>
    </Menu>
  );

  const body = (() => {
    if (!current) {
      return (
        <LoadingRegion label={doc.name} className="flex flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-5 w-48 rounded-md" />
          <Skeleton className="h-44 w-full rounded-md" />
        </LoadingRegion>
      );
    }
    if (current.failed) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-ui text-muted-foreground">Couldn't open {doc.name}.</p>
          <Button size="sm" variant="secondary" onClick={() => void download()}>
            Download
          </Button>
        </div>
      );
    }
    if (mediaMode && current.url && !(mediaMode === "pdf" && pdfFailed)) {
      return (
        <div
          className={
            mediaMode === "pdf"
              ? "flex h-full min-h-0 flex-1 flex-col overflow-hidden p-2 @[560px]/panel:p-4"
              : "flex h-full min-h-0 flex-1 items-center justify-center overflow-auto p-4"
          }
        >
          <FileMedia
            // The browser's viewer paints its own dark toolbar and backdrop; asking it for the
            // page alone (no toolbar or side panel, fit to width) leaves the theme's frame around it.
            url={
              mediaMode === "pdf" ? `${current.url}#toolbar=0&navpanes=0&view=FitH` : current.url
            }
            name={doc.name}
            mode={mediaMode}
            frame={{ height: "100%", flex: "1 1 0%" }}
            onError={() => {
              if (mediaMode === "pdf") setPdfFailed(true);
            }}
          />
        </div>
      );
    }
    if (markdown && current.text !== undefined) {
      return markdownMode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Prose text={current.text} className="max-w-none" />
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
          {current.text}
        </pre>
      );
    }
    if (current.text !== undefined && (info.preview === "text" || pdfFailed)) {
      return (
        <pre className="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
          {current.text}
        </pre>
      );
    }
    const meta = [info.label, doc.bytes > 0 ? formatBytes(doc.bytes) : ""]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-surface-1 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-soft)]">
          <Icon icon={fileIcon(doc.name)} size={36} />
        </span>
        <div className="flex max-w-xs flex-col gap-1">
          <p className="break-all text-ui font-semibold text-foreground">{doc.name}</p>
          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
        </div>
        {current.text && (
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{current.text}</p>
        )}
        <Button size="sm" variant="secondary" onClick={() => void download()}>
          <Icon icon={DownloadSimpleIcon} size={16} />
          Download
        </Button>
      </div>
    );
  })();

  return (
    <section
      aria-label={doc.name}
      className="@container/panel flex min-h-0 flex-1 flex-col bg-panel"
    >
      <PanelSurfaceHeader
        title={doc.name}
        onBack={props.onBack}
        onExpand={() => setFullscreen(true)}
        actions={overflow}
        border
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      {fullscreen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={doc.name}
            className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-md"
          >
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border-soft px-4">
              <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-foreground">
                {doc.name}
              </h2>
              {overflow}
              <IconButton
                icon={ArrowsInSimpleIcon}
                label="Exit full screen"
                tip="Exit full screen"
                size="default"
                className={roundButton}
                onClick={() => setFullscreen(false)}
              />
            </header>
            <div className="@container/panel flex min-h-0 flex-1 flex-col overflow-hidden">
              {body}
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
