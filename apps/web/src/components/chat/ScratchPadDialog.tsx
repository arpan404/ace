import {
  BrushIcon,
  EraserIcon,
  ImagePlusIcon,
  PenLineIcon,
  PlusIcon,
  StickyNoteIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  createScratchPadNote,
  EMPTY_SCRATCH_PAD_COLLECTION,
  resolveScratchPadPreview,
  resolveScratchPadTitle,
  SCRATCH_PAD_STORAGE_KEY,
  ScratchPadCollectionSchema,
  type ScratchPadCollection,
  type ScratchPadNote,
} from "./scratchPadStore";

const BRUSH_SIZES = [3, 6, 10, 16] as const;
const DEFAULT_SCRATCH_PAD_COLOR = "#111827";
const COLOR_SWATCHES = [
  DEFAULT_SCRATCH_PAD_COLOR,
  "#f8fafc",
  "#ef4444",
  "#22c55e",
  "#38bdf8",
  "#f59e0b",
];

type ScratchPadTool = "pen" | "eraser";

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
      }
      line = word;
    }
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

async function buildScratchPadExportBlob(
  canvas: HTMLCanvasElement,
  note: ScratchPadNote,
): Promise<Blob | null> {
  const trimmedNotes = note.body.trim();
  const notesWidth = trimmedNotes
    ? Math.min(420, Math.max(280, Math.round(canvas.width * 0.32)))
    : 0;
  const padding = 32;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = canvas.width + notesWidth;
  exportCanvas.height = canvas.height;
  const context = exportCanvas.getContext("2d");
  if (!context) {
    return canvasToBlob(canvas);
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  context.drawImage(canvas, 0, 0);
  if (!trimmedNotes) {
    return canvasToBlob(exportCanvas);
  }

  context.fillStyle = "#f8fafc";
  context.fillRect(canvas.width, 0, notesWidth, exportCanvas.height);
  context.strokeStyle = "#e2e8f0";
  context.beginPath();
  context.moveTo(canvas.width + 0.5, 0);
  context.lineTo(canvas.width + 0.5, exportCanvas.height);
  context.stroke();

  context.fillStyle = "#0f172a";
  context.font = "600 24px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  context.fillText(resolveScratchPadTitle(note), canvas.width + padding, padding + 8);
  context.font = "18px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  context.fillStyle = "#334155";
  const lines = wrapCanvasText(context, trimmedNotes, notesWidth - padding * 2);
  let y = padding + 52;
  for (const line of lines) {
    if (y > exportCanvas.height - padding) {
      context.fillText("...", canvas.width + padding, y);
      break;
    }
    context.fillText(line, canvas.width + padding, y);
    y += 28;
  }

  return canvasToBlob(exportCanvas);
}

export function ScratchPadDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttachImage: (file: File) => void;
  requestedNoteId: string | null;
  threadId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [collection, setCollection] = useLocalStorage<ScratchPadCollection, ScratchPadCollection>(
    SCRATCH_PAD_STORAGE_KEY,
    EMPTY_SCRATCH_PAD_COLLECTION,
    ScratchPadCollectionSchema,
  );
  const [tool, setTool] = useState<ScratchPadTool>("pen");
  const [color, setColor] = useState(DEFAULT_SCRATCH_PAD_COLOR);
  const [brushSize, setBrushSize] = useState<(typeof BRUSH_SIZES)[number]>(BRUSH_SIZES[1]);
  const [history, setHistory] = useState<string[]>([]);
  const threadNotes = useMemo(
    () =>
      collection.notes
        .filter((note) => note.threadId === undefined || note.threadId === props.threadId)
        .toSorted((left, right) => right.updatedAt - left.updatedAt),
    [collection.notes, props.threadId],
  );
  const activeNote =
    threadNotes.find((note) => note.id === collection.activeNoteId) ?? threadNotes[0] ?? null;

  const updateActiveNote = useCallback(
    (updater: (note: ScratchPadNote) => ScratchPadNote) => {
      if (!activeNote) return;
      setCollection((current) => ({
        ...current,
        activeNoteId: activeNote.id,
        notes: current.notes.map((note) =>
          note.id === activeNote.id ? updater({ ...note, updatedAt: Date.now() }) : note,
        ),
      }));
    },
    [activeNote, setCollection],
  );

  const createNote = useCallback(() => {
    const note = createScratchPadNote({
      threadId: props.threadId,
      title: `Scratch ${threadNotes.length + 1}`,
    });
    setCollection((current) => ({
      activeNoteId: note.id,
      notes: [note, ...current.notes],
    }));
    setHistory([]);
  }, [props.threadId, setCollection, threadNotes.length]);

  const deleteActiveNote = useCallback(() => {
    if (!activeNote) return;
    setCollection((current) => {
      const notes = current.notes.filter((note) => note.id !== activeNote.id);
      const nextThreadNote = notes
        .filter((note) => note.threadId === undefined || note.threadId === props.threadId)
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
      return {
        activeNoteId: nextThreadNote?.id ?? null,
        notes,
      };
    });
    setHistory([]);
  }, [activeNote, props.threadId, setCollection]);

  const drawSavedImage = useCallback((imageDataUrl: string | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!imageDataUrl) return;
    const image = new Image();
    image.addEventListener(
      "load",
      () => {
        context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        context.drawImage(image, 0, 0, canvas.clientWidth, canvas.clientHeight);
      },
      { once: true },
    );
    image.src = imageDataUrl;
  }, []);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.round(bounds.width * ratio));
    const nextHeight = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";
    drawSavedImage(activeNote?.imageDataUrl ?? null);
  }, [activeNote?.imageDataUrl, drawSavedImage]);

  useEffect(() => {
    if (!props.open) return;
    if (props.requestedNoteId) {
      setCollection((current) =>
        current.notes.some((note) => note.id === props.requestedNoteId)
          ? { ...current, activeNoteId: props.requestedNoteId }
          : current,
      );
      return;
    }
    if (threadNotes.length === 0) {
      const note = createScratchPadNote({ threadId: props.threadId, title: "Working scratch" });
      setCollection({
        activeNoteId: note.id,
        notes: [note, ...collection.notes],
      });
    }
  }, [
    collection.notes,
    props.open,
    props.requestedNoteId,
    props.threadId,
    setCollection,
    threadNotes.length,
  ]);

  useEffect(() => {
    if (!props.open) return;
    const frameId = window.requestAnimationFrame(resizeCanvas);
    window.addEventListener("resize", resizeCanvas);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [props.open, resizeCanvas]);

  useEffect(() => {
    if (props.open) {
      drawSavedImage(activeNote?.imageDataUrl ?? null);
    }
  }, [activeNote?.imageDataUrl, activeNote?.id, drawSavedImage, props.open]);

  const currentCanvasDataUrl = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.toDataURL("image/png");
  }, []);

  const persistCanvas = useCallback(() => {
    const imageDataUrl = currentCanvasDataUrl();
    if (!imageDataUrl) return;
    updateActiveNote((note) => ({
      ...note,
      imageDataUrl,
    }));
  }, [currentCanvasDataUrl, updateActiveNote]);

  const getCanvasPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  }, []);

  const beginStroke = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const point = getCanvasPoint(event);
      const canvas = canvasRef.current;
      if (!point || !canvas) return;
      const snapshot = currentCanvasDataUrl();
      if (snapshot) {
        setHistory((current) => [...current.slice(-14), snapshot]);
      }
      drawingRef.current = true;
      lastPointRef.current = point;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [currentCanvasDataUrl, getCanvasPoint],
  );

  const drawStroke = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const point = getCanvasPoint(event);
      const previousPoint = lastPointRef.current;
      const canvas = canvasRef.current;
      if (!point || !previousPoint || !canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.save();
      context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      context.strokeStyle = color;
      context.lineWidth = tool === "eraser" ? brushSize * 1.8 : brushSize;
      context.beginPath();
      context.moveTo(previousPoint.x, previousPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      context.restore();
      lastPointRef.current = point;
    },
    [brushSize, color, getCanvasPoint, tool],
  );

  const endStroke = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      lastPointRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      persistCanvas();
    },
    [persistCanvas],
  );

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.at(-1);
      if (!previous) return current;
      updateActiveNote((note) => ({
        ...note,
        imageDataUrl: previous,
      }));
      return current.slice(0, -1);
    });
  }, [updateActiveNote]);

  const clearCanvas = useCallback(() => {
    const snapshot = currentCanvasDataUrl();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    if (snapshot) {
      setHistory((current) => [...current.slice(-14), snapshot]);
    }
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    updateActiveNote((note) => ({
      ...note,
      imageDataUrl: null,
    }));
  }, [currentCanvasDataUrl, updateActiveNote]);

  const attachImage = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !activeNote) return;
    const blob = await buildScratchPadExportBlob(canvas, activeNote);
    if (!blob) return;
    props.onAttachImage(
      new File([blob], `${resolveScratchPadTitle(activeNote)}.png`, {
        type: "image/png",
      }),
    );
  }, [activeNote, props]);

  const hasCanvasContent = Boolean(activeNote?.imageDataUrl);
  const notesPlaceholder = useMemo(
    () => "Keep assumptions, file paths, commands, blockers, review notes, and follow-ups here.",
    [],
  );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        className="flex h-[min(44rem,calc(100dvh-1rem))] max-h-none w-[min(64rem,calc(100vw-1rem))] max-w-none flex-col overflow-hidden border-border/80 bg-background p-0 shadow-2xl"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border/55 bg-muted/10 px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="sr-only">Notes</DialogTitle>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <StickyNoteIcon className="size-4 text-muted-foreground" />
              Scratchpad
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              Working memory for this coding thread
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" type="button" variant="ghost" className="h-8" onClick={createNote}>
              <PlusIcon className="size-4" />
              New
            </Button>
            <Button size="sm" type="button" variant="outline" className="h-8" onClick={attachImage}>
              <ImagePlusIcon className="size-4" />
              Attach
            </Button>
            <Button
              size="icon-sm"
              type="button"
              variant="ghost"
              aria-label="Close notes"
              onClick={() => props.onOpenChange(false)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 bg-background md:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="flex min-h-32 flex-col border-b border-border/55 bg-muted/12 md:min-h-0 md:border-r md:border-b-0">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Notes
              </span>
              <Button
                size="icon-sm"
                type="button"
                variant="ghost"
                onClick={createNote}
                aria-label="New note"
              >
                <PlusIcon className="size-4" />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden px-2 pb-2 md:block md:space-y-1 md:overflow-y-auto md:overflow-x-hidden">
              {threadNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className={cn(
                    "w-40 shrink-0 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors md:w-full",
                    note.id === activeNote?.id
                      ? "border-border/70 bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/65 hover:text-foreground",
                  )}
                  onClick={() => {
                    setCollection((current) => ({ ...current, activeNoteId: note.id }));
                    setHistory([]);
                  }}
                >
                  <span className="block truncate text-[12px] font-medium leading-5">
                    {resolveScratchPadTitle(note)}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                    {resolveScratchPadPreview(note)}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto p-3">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-3">
              <section className="overflow-hidden rounded-xl border border-border/65 bg-card shadow-sm">
                <div className="flex items-center gap-2 border-b border-border/55 px-3 py-2">
                  <StickyNoteIcon className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    value={activeNote?.title ?? ""}
                    onChange={(event) =>
                      updateActiveNote((note) => ({
                        ...note,
                        title: event.target.value,
                      }))
                    }
                    placeholder="Working scratch"
                    className="h-7 w-full min-w-0 bg-transparent text-sm font-semibold outline-none placeholder:text-muted-foreground/50"
                  />
                </div>
                <textarea
                  value={activeNote?.body ?? ""}
                  onChange={(event) =>
                    updateActiveNote((note) => ({
                      ...note,
                      body: event.target.value,
                    }))
                  }
                  placeholder={notesPlaceholder}
                  className="h-28 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/45"
                />
              </section>

              <section className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border/65 bg-card shadow-sm">
                <div className="flex flex-wrap items-center gap-2 border-b border-border/55 bg-muted/12 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    <BrushIcon className="size-3.5" />
                    Canvas
                  </div>
                  <div className="ml-auto flex items-center gap-1 rounded-lg border border-border/55 bg-background p-0.5">
                    <Button
                      size="icon-sm"
                      type="button"
                      variant={tool === "pen" ? "secondary" : "ghost"}
                      className="size-7"
                      onClick={() => setTool("pen")}
                      aria-label="Pen"
                    >
                      <PenLineIcon className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      type="button"
                      variant={tool === "eraser" ? "secondary" : "ghost"}
                      className="size-7"
                      onClick={() => setTool("eraser")}
                      aria-label="Eraser"
                    >
                      <EraserIcon className="size-4" />
                    </Button>
                  </div>

                  <div className="flex items-center gap-1 rounded-lg border border-border/55 bg-background px-1.5 py-1">
                    {COLOR_SWATCHES.map((swatch) => (
                      <button
                        key={swatch}
                        type="button"
                        className={cn(
                          "size-4 rounded-full border border-border/70",
                          color === swatch && "ring-1 ring-ring",
                        )}
                        style={{ backgroundColor: swatch }}
                        aria-label={`Use color ${swatch}`}
                        onClick={() => {
                          setColor(swatch);
                          setTool("pen");
                        }}
                      />
                    ))}
                  </div>

                  <div className="flex items-center gap-1 rounded-lg border border-border/55 bg-background px-1 py-0.5">
                    {BRUSH_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={cn(
                          "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground",
                          brushSize === size && "bg-accent text-accent-foreground",
                        )}
                        aria-label={`Use ${size}px brush`}
                        onClick={() => setBrushSize(size)}
                      >
                        <span
                          className="rounded-full bg-current"
                          style={{ width: size, height: size }}
                        />
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                      disabled={history.length === 0}
                      aria-label="Undo stroke"
                      onClick={undo}
                    >
                      <Undo2Icon className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                      disabled={!hasCanvasContent}
                      aria-label="Clear drawing"
                      onClick={clearCanvas}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                      disabled={!activeNote}
                      aria-label="Delete note"
                      onClick={deleteActiveNote}
                    >
                      <XIcon className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                      aria-label="Attach note"
                      onClick={attachImage}
                    >
                      <ImagePlusIcon className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/10 p-3">
                  <div className="w-full max-w-2xl rounded-xl border border-border/65 bg-background p-2 shadow-sm">
                    <canvas
                      ref={canvasRef}
                      className="aspect-[16/10] max-h-[24rem] min-h-[15rem] w-full touch-none rounded-lg border border-border/70 bg-white shadow-inner"
                      onPointerDown={beginStroke}
                      onPointerMove={drawStroke}
                      onPointerUp={endStroke}
                      onPointerCancel={endStroke}
                      onPointerLeave={endStroke}
                    />
                  </div>
                </div>
              </section>
            </div>
          </main>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
