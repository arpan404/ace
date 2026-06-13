import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { CheckIcon, CopyIcon, GlobeIcon } from "lucide-react";
import React, {
  Children,
  Profiler,
  Suspense,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { openInPreferredEditor } from "../editorPreferences";
import { runAsyncTask } from "../lib/async";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import {
  registerMemoryPressureHandler,
  shouldBypassNonEssentialCaching,
} from "../lib/memoryPressure";
import { clampCacheBudgetBytes, clampCacheEntryCount } from "../lib/resourceProfile";
import { useTheme } from "../hooks/useTheme";
import { buildLargeMarkdownPreviewText } from "../lib/chat/messageText";
import {
  analyzeMarkdownRender,
  buildMarkdownRenderAnalysisCacheKey,
  shouldWorkerizeMarkdownRenderAnalysis,
} from "../lib/chat/markdownRenderAnalysis";
import {
  prewarmMarkdownRenderAnalysis,
  readCachedMarkdownRenderAnalysis,
} from "../lib/chat/markdownRenderAnalysisClient";
import { normalizeBrowserHttpUrl } from "../lib/browser/url";
import { isRenderProfilingEnabled, recordReactRenderProfile } from "../lib/renderProfiling";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import type { ChatMessageStreamingTextState } from "../types";
import { renderTrustedHighlightedHtml } from "./TrustedHighlightedHtml";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
const MermaidDiagram = React.lazy(() => import("./MermaidDiagram"));

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  analysisCacheKey?: string;
  isStreaming?: boolean;
  renderPlainText?: boolean;
  streamingTextState?: ChatMessageStreamingTextState;
  onLayoutChange?: () => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void | Promise<void>) | null;
  enableLocalFileLinks?: boolean;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const STREAMING_REVEAL_MIN_CHARS_PER_FRAME = 12;
const STREAMING_REVEAL_MAX_CHARS_PER_FRAME = 768;
const STREAMING_REVEAL_BURST_RATIO = 0.34;
const MAX_HIGHLIGHT_CACHE_ENTRIES = clampCacheEntryCount(500, {
  moderateCapEntries: 320,
  constrainedCapEntries: 160,
});
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = clampCacheBudgetBytes(50 * 1024 * 1024, {
  moderateCapBytes: 24 * 1024 * 1024,
  constrainedCapBytes: 12 * 1024 * 1024,
});
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const pendingHighlightByCacheKey = new Map<string, Promise<void>>();
const highlightedCodeCacheListeners = new Set<() => void>();
let highlightedCodeCacheRevision = 0;
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_DATA_IMAGE_URL_REGEX = /^data:image\/(?:png|jpe?g|gif|webp);base64,/iu;
const localFilePathExistsCache = new Map<string, boolean>();
const localFilePathExistsCacheListeners = new Set<() => void>();

function writeLocalFilePathExistsCache(targetPath: string, exists: boolean): void {
  localFilePathExistsCache.set(targetPath, exists);
  for (const listener of localFilePathExistsCacheListeners) {
    listener();
  }
}

function subscribeLocalFilePathExistsCache(listener: () => void): () => void {
  localFilePathExistsCacheListeners.add(listener);
  return () => {
    localFilePathExistsCacheListeners.delete(listener);
  };
}
const onMarkdownProfilerRender = (
  _id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
) => {
  recordReactRenderProfile("chat.markdown.render", phase, actualDuration);
};

function markdownUrlTransform(value: string, key: string): string {
  if (key === "src" && MARKDOWN_DATA_IMAGE_URL_REGEX.test(value)) {
    return value;
  }
  return defaultUrlTransform(value);
}

function joinClassNames(...values: ReadonlyArray<string | undefined>): string | undefined {
  const className = values.filter((value): value is string => Boolean(value)).join(" ");
  return className.length > 0 ? className : undefined;
}

registerMemoryPressureHandler({
  id: "markdown-highlight-cache",
  minLevel: "high",
  release: () => {
    highlightedCodeCache.clear();
    highlighterPromiseCache.clear();
    pendingHighlightByCacheKey.clear();
    notifyHighlightedCodeCacheListeners();
  },
});

function notifyHighlightedCodeCacheListeners(): void {
  highlightedCodeCacheRevision += 1;
  for (const listener of highlightedCodeCacheListeners) {
    listener();
  }
}

function subscribeHighlightedCodeCache(listener: () => void): () => void {
  highlightedCodeCacheListeners.add(listener);
  return () => {
    highlightedCodeCacheListeners.delete(listener);
  };
}

function readHighlightedCodeCacheRevision(): number {
  return highlightedCodeCacheRevision;
}

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = (match?.[1] ?? "text").toLowerCase();
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function isSingleLineMarkdownNode(node: unknown): boolean {
  const position = (
    node as {
      position?: {
        start?: { line?: number | undefined } | undefined;
        end?: { line?: number | undefined } | undefined;
      };
    }
  )?.position;
  const startLine = position?.start?.line;
  const endLine = position?.end?.line;
  return (
    typeof startLine === "number" &&
    typeof endLine === "number" &&
    Number.isFinite(startLine) &&
    Number.isFinite(endLine) &&
    startLine === endLine
  );
}

function openLocalFilePath(input: {
  readonly targetPath: string;
  readonly onOpenFilePath: ((path: string) => void | Promise<void>) | null;
  readonly preferExternalEditor: boolean;
}): void {
  if (!input.preferExternalEditor && input.onOpenFilePath) {
    void Promise.resolve(input.onOpenFilePath(input.targetPath)).catch((error) => {
      console.warn("Failed to open local filesystem path.", error);
    });
    return;
  }
  const api = readNativeApi();
  if (!api) {
    console.warn("Native API not found. Unable to open file in editor.");
    return;
  }
  void (async () => {
    try {
      const pathInfo = await api.shell.pathInfo(input.targetPath);
      if (pathInfo.kind === "directory") {
        await api.shell.revealInFileManager(input.targetPath);
        return;
      }
    } catch (error) {
      console.warn("Failed to inspect local filesystem path before opening editor.", error);
    }
    await openInPreferredEditor(api, input.targetPath);
  })().catch((error) => {
    console.warn("Failed to open local filesystem path.", error);
  });
}

function openLinkExternally(href: string) {
  const api = readNativeApi();
  if (api) {
    void api.shell.openExternal(href).catch((error) => {
      console.warn("Failed to open link externally.", error);
    });
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function InlineCodeLocalFileLink(props: {
  readonly children: ReactNode;
  readonly code: string;
  readonly codeProps: ComponentPropsWithoutRef<"code">;
  readonly cwd: string | undefined;
  readonly enabled: boolean;
  readonly onOpenFilePath: ((path: string) => void | Promise<void>) | null;
}) {
  const targetPath = props.enabled ? resolveMarkdownFileLinkTarget(props.code, props.cwd) : null;
  const cachedExists = useSyncExternalStore(
    subscribeLocalFilePathExistsCache,
    () => (props.enabled && targetPath ? localFilePathExistsCache.get(targetPath) : undefined),
    () => undefined,
  );
  const pathExists = !props.enabled || !targetPath ? false : cachedExists === true;

  useEffect(() => {
    if (!props.enabled || !targetPath || cachedExists !== undefined) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let exists = false;
      try {
        exists = await api.shell.pathExists(targetPath);
      } catch (error) {
        console.warn("Failed to check local file path.", error);
      }
      if (!cancelled) {
        writeLocalFilePathExistsCache(targetPath, exists);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cachedExists, props.enabled, targetPath]);

  const codeElement = <code {...props.codeProps}>{props.children}</code>;
  if (!targetPath || !pathExists) {
    return codeElement;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Open local file ${targetPath}`}
            className="chat-markdown-local-file-link"
            onClick={(event) => {
              event.stopPropagation();
              openLocalFilePath({
                targetPath,
                onOpenFilePath: props.onOpenFilePath,
                preferExternalEditor: event.metaKey || event.ctrlKey,
              });
            }}
          />
        }
      >
        {codeElement}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
        Open {targetPath}
      </TooltipPopup>
    </Tooltip>
  );
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      highlighterPromiseCache.delete(language);
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    const fallbackPromise = getHighlighterPromise("text").catch((fallbackError) => {
      highlighterPromiseCache.delete(language);
      throw fallbackError;
    });
    highlighterPromiseCache.set(language, fallbackPromise);
    return fallbackPromise;
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function writeHighlightedCodeCache(cacheKey: string, highlightedHtml: string, code: string): void {
  if (shouldBypassNonEssentialCaching()) {
    return;
  }
  highlightedCodeCache.set(
    cacheKey,
    highlightedHtml,
    estimateHighlightedSize(highlightedHtml, code),
  );
  notifyHighlightedCodeCacheListeners();
}

async function buildHighlightedCodeHtml(input: {
  readonly code: string;
  readonly language: string;
  readonly themeName: DiffThemeName;
}): Promise<string> {
  const highlighter = await getHighlighterPromise(input.language);
  try {
    return highlighter.codeToHtml(input.code, {
      lang: input.language,
      theme: input.themeName,
    });
  } catch (error) {
    // Log highlighting failures for debugging while falling back to plain text.
    console.warn(
      `Code highlighting failed for language "${input.language}", falling back to plain text.`,
      error instanceof Error ? error.message : error,
    );
    return highlighter.codeToHtml(input.code, { lang: "text", theme: input.themeName });
  }
}

function prewarmHighlightedCode(input: {
  readonly cacheKey: string;
  readonly code: string;
  readonly language: string;
  readonly themeName: DiffThemeName;
}): Promise<void> {
  if (highlightedCodeCache.peek(input.cacheKey) !== null) {
    return Promise.resolve();
  }
  const pending = pendingHighlightByCacheKey.get(input.cacheKey);
  if (pending) {
    return pending;
  }

  const promise = buildHighlightedCodeHtml(input)
    .then((highlightedHtml) => {
      writeHighlightedCodeCache(input.cacheKey, highlightedHtml, input.code);
    })
    .catch((error) => {
      console.warn(
        `Code highlighting failed for language "${input.language}", keeping plain text fallback.`,
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      pendingHighlightByCacheKey.delete(input.cacheKey);
    });
  pendingHighlightByCacheKey.set(input.cacheKey, promise);
  return promise;
}

function useCachedHighlightedCode(cacheKey: string, enabled: boolean): string | null {
  const cacheRevision = useSyncExternalStore(
    subscribeHighlightedCodeCache,
    readHighlightedCodeCacheRevision,
    readHighlightedCodeCacheRevision,
  );
  void cacheRevision;
  return enabled ? highlightedCodeCache.peek(cacheKey) : null;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    runAsyncTask(
      navigator.clipboard.writeText(code).then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      }),
      "Failed to copy markdown code to the clipboard.",
    );
  };

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="chat-markdown-copy-button"
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy code"}
            />
          }
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{copied ? "Copied" : "Copy code"}</TooltipPopup>
      </Tooltip>
      {children}
    </div>
  );
}

function MermaidDiagramLoading({ className }: { className?: string }) {
  return (
    <div
      className={[
        "flex min-h-[120px] items-center justify-center rounded-lg border border-border/60 bg-muted/35 px-3 text-xs text-muted-foreground/75",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-mermaid-diagram-state="loading"
    >
      Rendering Mermaid diagram…
    </div>
  );
}

interface ShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  fallback: ReactNode;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function ShikiCodeBlock({
  className,
  code,
  fallback,
  themeName,
  isStreaming,
}: ShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = useCachedHighlightedCode(cacheKey, !isStreaming);

  useEffect(() => {
    if (isStreaming || cachedHighlightedHtml !== null) {
      return;
    }
    void prewarmHighlightedCode({ cacheKey, code, language, themeName });
  }, [cacheKey, cachedHighlightedHtml, code, isStreaming, language, themeName]);

  if (cachedHighlightedHtml !== null) {
    return <HighlightedShikiCodeBlock highlightedHtml={cachedHighlightedHtml} />;
  }

  return <>{fallback}</>;
}

function HighlightedShikiCodeBlock({ highlightedHtml }: { highlightedHtml: string }) {
  const highlightedChildren = renderTrustedHighlightedHtml(highlightedHtml);
  return <div className="chat-markdown-shiki">{highlightedChildren}</div>;
}

function StreamingMarkdownText({ text }: { text: string }) {
  return (
    <div
      className="chat-markdown-streaming wrap-break-word whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground/80"
      data-streaming-markdown="true"
    >
      {text}
    </div>
  );
}

function useSmoothStreamingText(text: string, isStreaming: boolean): string {
  const [displayText, setDisplayText] = useState(text);
  const displayTextRef = useRef(text);
  const targetTextRef = useRef(text);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    displayTextRef.current = displayText;
  }, [displayText]);

  useEffect(() => {
    if (
      !isStreaming ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      targetTextRef.current = text;
      displayTextRef.current = text;
      return;
    }

    targetTextRef.current = text;

    if (!text.startsWith(displayTextRef.current)) {
      displayTextRef.current = text;
      setDisplayText(text);
      return;
    }

    if (frameRef.current !== null) {
      return;
    }

    const revealNextFrame = () => {
      frameRef.current = null;
      const currentText = displayTextRef.current;
      const targetText = targetTextRef.current;

      if (currentText === targetText) {
        return;
      }

      const remainingCharCount = targetText.length - currentText.length;
      if (remainingCharCount <= 0 || !targetText.startsWith(currentText)) {
        displayTextRef.current = targetText;
        setDisplayText(targetText);
        return;
      }

      const revealCharCount = Math.min(
        remainingCharCount,
        Math.max(
          STREAMING_REVEAL_MIN_CHARS_PER_FRAME,
          Math.min(
            STREAMING_REVEAL_MAX_CHARS_PER_FRAME,
            Math.ceil(remainingCharCount * STREAMING_REVEAL_BURST_RATIO),
          ),
        ),
      );
      const nextText = targetText.slice(0, currentText.length + revealCharCount);
      displayTextRef.current = nextText;
      setDisplayText(nextText);

      if (nextText !== targetText) {
        frameRef.current = window.requestAnimationFrame(revealNextFrame);
      }
    };

    frameRef.current = window.requestAnimationFrame(revealNextFrame);

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isStreaming, text]);

  return isStreaming ? displayText : text;
}

function PlainMarkdownText({ text }: { text: string }) {
  return (
    <div className="chat-markdown w-full min-w-0 wrap-break-word whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground/80">
      {text}
    </div>
  );
}

function MarkdownBody({
  children,
  isStreaming,
  markdownComponents,
}: {
  children: string;
  isStreaming: boolean;
  markdownComponents: Components;
}) {
  const markdown = (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      components={markdownComponents}
      urlTransform={markdownUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );

  return (
    <div
      className="chat-markdown w-full min-w-0 text-[13px] leading-[1.55] text-foreground/80"
      data-streaming-markdown={isStreaming ? "true" : undefined}
    >
      {isRenderProfilingEnabled() ? (
        <Profiler id="chat-markdown" onRender={onMarkdownProfilerRender}>
          {markdown}
        </Profiler>
      ) : (
        markdown
      )}
    </div>
  );
}

function PreviewTextPanel({
  text,
  dataAttribute,
}: {
  text: string;
  dataAttribute?: "data-streaming-markdown" | "data-large-markdown-preview";
}) {
  return (
    <div
      className="max-h-96 overflow-auto p-0"
      {...(dataAttribute ? { [dataAttribute]: "true" } : {})}
    >
      <div className="chat-markdown-streaming wrap-break-word whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground/80">
        {text}
      </div>
    </div>
  );
}

function StreamingMarkdownPreview({
  text,
  streamingTextState,
}: {
  text: string;
  streamingTextState: ChatMessageStreamingTextState | undefined;
}) {
  const previewIsTruncated =
    (streamingTextState?.truncatedCharCount ?? 0) > 0 ||
    (streamingTextState?.truncatedLineCount ?? 0) > 0;
  if (!previewIsTruncated) {
    return <StreamingMarkdownText text={text} />;
  }

  return (
    <div className="space-y-2" data-streaming-markdown="true">
      <p className="text-[11px] text-muted-foreground/70">
        Showing the latest{" "}
        <span className="font-medium text-foreground/80">
          {streamingTextState?.previewLineCount.toLocaleString() ?? "0"}
        </span>{" "}
        of{" "}
        <span className="font-medium text-foreground/80">
          {streamingTextState?.totalLineCount.toLocaleString() ?? "0"}
        </span>{" "}
        lines while the response streams.
      </p>
      <PreviewTextPanel text={text} />
    </div>
  );
}

function LargeMarkdownPreview({
  previewText,
  totalCharacters,
  isTransitionPending,
  onRenderMarkdown,
}: {
  previewText: string;
  totalCharacters: number;
  isTransitionPending: boolean;
  onRenderMarkdown: () => void;
}) {
  return (
    <div className="space-y-3" data-large-markdown-preview="true">
      <div className="space-y-1">
        <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground/75 uppercase">
          Large response preview
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          Rendering this as plain text first keeps scrolling and streaming responsive.
        </p>
      </div>
      <PreviewTextPanel text={previewText} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center rounded-md border border-border/50 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border/80 hover:bg-secondary/50"
          onClick={onRenderMarkdown}
          disabled={isTransitionPending}
        >
          {isTransitionPending ? "Rendering markdown..." : "Render full markdown"}
        </button>
        <span className="text-[11px] text-muted-foreground/65">
          {totalCharacters.toLocaleString()} chars
        </span>
      </div>
    </div>
  );
}

function useChatMarkdownRenderState(input: {
  analysisCacheKey: string | undefined;
  isStreaming: boolean;
  renderPlainText: boolean;
  renderPreference: "auto" | "markdown";
  streamingTextState: ChatMarkdownProps["streamingTextState"];
  text: string;
}) {
  const markdownRenderAnalysisInput = {
    text: input.text,
    isStreaming: input.isStreaming,
    renderPlainText: input.renderPlainText,
    ...(input.streamingTextState
      ? {
          streamingTextState: {
            totalLineCount: input.streamingTextState.totalLineCount,
            truncatedCharCount: input.streamingTextState.truncatedCharCount,
            truncatedLineCount: input.streamingTextState.truncatedLineCount,
          },
        }
      : {}),
  };
  const resolvedAnalysisCacheKey = buildMarkdownRenderAnalysisCacheKey(
    markdownRenderAnalysisInput,
    input.analysisCacheKey,
  );
  const cachedMarkdownRenderAnalysis = readCachedMarkdownRenderAnalysis(resolvedAnalysisCacheKey);
  const markdownRenderAnalysis =
    cachedMarkdownRenderAnalysis ?? analyzeMarkdownRender(markdownRenderAnalysisInput);
  const effectiveRenderPreference = input.isStreaming ? "auto" : input.renderPreference;
  const useLargePreview =
    effectiveRenderPreference !== "markdown" && markdownRenderAnalysis.useLargePreview;
  const shouldFastPathPlainText = markdownRenderAnalysis.shouldFastPathPlainText;
  const shouldObserveLayout = markdownRenderAnalysis.shouldObserveLayout;

  useEffect(() => {
    if (cachedMarkdownRenderAnalysis) return;
    const prewarmInput = {
      text: input.text,
      isStreaming: input.isStreaming,
      renderPlainText: input.renderPlainText,
      ...(input.streamingTextState
        ? {
            streamingTextState: {
              totalLineCount: input.streamingTextState.totalLineCount,
              truncatedCharCount: input.streamingTextState.truncatedCharCount,
              truncatedLineCount: input.streamingTextState.truncatedLineCount,
            },
          }
        : {}),
    };
    if (!shouldWorkerizeMarkdownRenderAnalysis(prewarmInput)) return;
    prewarmMarkdownRenderAnalysis(resolvedAnalysisCacheKey, prewarmInput);
  }, [
    cachedMarkdownRenderAnalysis,
    input.isStreaming,
    input.renderPlainText,
    input.streamingTextState,
    input.text,
    resolvedAnalysisCacheKey,
  ]);

  return {
    markdownRenderAnalysis,
    shouldFastPathPlainText,
    shouldObserveLayout,
    useLargePreview,
  };
}

function ChatMarkdown({
  text,
  cwd,
  analysisCacheKey,
  isStreaming = false,
  renderPlainText = false,
  streamingTextState,
  onLayoutChange,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
  enableLocalFileLinks = true,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const [renderPreference, setRenderPreference] = useState<"auto" | "markdown">("auto");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isMarkdownTransitionPending, startMarkdownTransition] = useTransition();
  const displayText = useSmoothStreamingText(text, isStreaming);
  const {
    markdownRenderAnalysis,
    shouldFastPathPlainText,
    shouldObserveLayout: shouldObserveLayoutFromAnalysis,
    useLargePreview,
  } = useChatMarkdownRenderState({
    analysisCacheKey,
    isStreaming,
    renderPlainText,
    renderPreference,
    streamingTextState,
    text: displayText,
  });
  const shouldObserveLayout = onLayoutChange !== undefined && shouldObserveLayoutFromAnalysis;
  const canOpenLocalFiles = enableLocalFileLinks && !isStreaming;

  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, children, className, title, ...props }) {
        const targetPath = canOpenLocalFiles ? resolveMarkdownFileLinkTarget(href, cwd) : null;
        if (!targetPath) {
          const browserUrl = href ? normalizeBrowserHttpUrl(href) : null;
          if (!browserUrl || !onOpenBrowserUrl) {
            return (
              <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          }

          return (
            <span className="chat-markdown-link-shell">
              <button
                type="button"
                className={joinClassNames("chat-markdown-link-button", className)}
                title={title}
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.metaKey || event.ctrlKey) {
                    openLinkExternally(href ?? browserUrl);
                    return;
                  }
                  onOpenBrowserUrl(browserUrl);
                }}
              >
                {children}
              </button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="chat-markdown-link-open-browser"
                      aria-label="Open link in the in-app browser"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenBrowserUrl(browserUrl);
                      }}
                    />
                  }
                >
                  <GlobeIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Open in in-app browser</TooltipPopup>
              </Tooltip>
            </span>
          );
        }

        return (
          <button
            type="button"
            className={joinClassNames(
              "chat-markdown-link-button",
              "chat-markdown-local-file-link",
              className,
            )}
            title={title}
            onClick={(event) => {
              event.stopPropagation();
              openLocalFilePath({
                targetPath,
                onOpenFilePath,
                preferExternalEditor: event.metaKey || event.ctrlKey,
              });
            }}
          >
            {children}
          </button>
        );
      },
      code({ node, className, children, ...props }) {
        const code = nodeToPlainText(children);
        const isInlineCode =
          !className && !code.includes("\n") && code.length > 0 && isSingleLineMarkdownNode(node);
        if (!isInlineCode) {
          return (
            <code {...props} className={className}>
              {children}
            </code>
          );
        }
        return (
          <InlineCodeLocalFileLink
            code={code}
            codeProps={{ ...props, className }}
            cwd={cwd}
            enabled={canOpenLocalFiles}
            onOpenFilePath={onOpenFilePath}
          >
            {children}
          </InlineCodeLocalFileLink>
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }
        if (isStreaming) {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <pre {...props}>{children}</pre>
            </MarkdownCodeBlock>
          );
        }
        const language = extractFenceLanguage(codeBlock.className);

        if (language === "mermaid") {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <Suspense fallback={<MermaidDiagramLoading className="chat-markdown-mermaid" />}>
                <MermaidDiagram
                  source={codeBlock.code}
                  theme={resolvedTheme}
                  className="chat-markdown-mermaid"
                />
              </Suspense>
            </MarkdownCodeBlock>
          );
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <ShikiCodeBlock
                className={codeBlock.className}
                code={codeBlock.code}
                fallback={<pre {...props}>{children}</pre>}
                themeName={diffThemeName}
                isStreaming={isStreaming}
              />
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
      img({ node: _node, alt, ...props }) {
        return (
          <img
            {...props}
            alt={alt ?? ""}
            className="my-2 max-h-[70vh] max-w-full rounded-lg border border-border/55 bg-background/70 object-contain"
          />
        );
      },
    }),
    [
      canOpenLocalFiles,
      cwd,
      diffThemeName,
      isStreaming,
      onOpenBrowserUrl,
      onOpenFilePath,
      resolvedTheme,
    ],
  );
  useEffect(() => {
    if (!onLayoutChange || !shouldObserveLayout || typeof ResizeObserver === "undefined") {
      return;
    }
    const rootElement = rootRef.current;
    if (!rootElement) {
      return;
    }

    let frameId: number | null = null;
    const notifyLayoutChange = () => {
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        onLayoutChange();
        return;
      }
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        onLayoutChange();
      });
    };

    const observer = new ResizeObserver(() => {
      notifyLayoutChange();
    });
    observer.observe(rootElement);

    return () => {
      observer.disconnect();
      if (frameId !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [onLayoutChange, shouldObserveLayout]);

  const content = renderPlainText ? (
    <PreviewTextPanel text={displayText} />
  ) : markdownRenderAnalysis.usesStreamingPreview && streamingTextState ? (
    <StreamingMarkdownPreview text={displayText} streamingTextState={streamingTextState} />
  ) : useLargePreview ? (
    <LargeMarkdownPreview
      previewText={
        markdownRenderAnalysis.largePreviewText ?? buildLargeMarkdownPreviewText(displayText)
      }
      totalCharacters={displayText.length}
      isTransitionPending={isMarkdownTransitionPending}
      onRenderMarkdown={() => {
        startMarkdownTransition(() => {
          setRenderPreference("markdown");
        });
      }}
    />
  ) : shouldFastPathPlainText ? (
    <PlainMarkdownText text={displayText} />
  ) : (
    <MarkdownBody isStreaming={isStreaming} markdownComponents={markdownComponents}>
      {displayText}
    </MarkdownBody>
  );

  return (
    <div
      ref={rootRef}
      className="w-full min-w-0"
      data-chat-markdown-live={isStreaming ? "true" : undefined}
    >
      {content}
    </div>
  );
}

export default ChatMarkdown;
