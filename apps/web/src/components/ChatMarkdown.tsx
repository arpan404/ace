import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon } from "lucide-react";
import React, {
  Children,
  Suspense,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
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
import {
  buildLargeMarkdownPreviewText,
  shouldUseLargeMarkdownPreview,
} from "../lib/chat/messageText";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import type { ChatMessageStreamingTextState } from "../types";

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
  isStreaming?: boolean;
  streamingTextState?: ChatMessageStreamingTextState;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
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
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

registerMemoryPressureHandler({
  id: "markdown-highlight-cache",
  minLevel: "high",
  release: () => {
    highlightedCodeCache.clear();
    highlighterPromiseCache.clear();
  },
});

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
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
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const shouldCachePromise = !shouldBypassNonEssentialCaching();
  const cached = shouldCachePromise ? highlighterPromiseCache.get(language) : undefined;
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  if (shouldCachePromise) {
    highlighterPromiseCache.set(language, promise);
  }
  return promise;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
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
  }, [code]);

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
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming && !shouldBypassNonEssentialCaching()) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

function StreamingMarkdownText({ text }: { text: string }) {
  return (
    <div
      className="chat-markdown-streaming wrap-break-word whitespace-pre-wrap text-sm leading-relaxed text-foreground/80"
      data-streaming-markdown="true"
    >
      {text}
    </div>
  );
}

function scheduleDeferredMarkdownUpgrade(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  if (typeof window.requestIdleCallback === "function") {
    const idleHandle = window.requestIdleCallback(
      () => {
        callback();
      },
      { timeout: 120 },
    );
    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
    };
  }

  const timeoutHandle = window.setTimeout(() => {
    callback();
  }, 0);
  return () => window.clearTimeout(timeoutHandle);
}

function PreviewTextPanel({
  text,
  dataAttribute,
}: {
  text: string;
  dataAttribute?:
    | "data-streaming-markdown"
    | "data-large-markdown-preview"
    | "data-deferred-markdown";
}) {
  return (
    <div
      className="max-h-96 overflow-auto rounded-md border border-border/35 bg-background/35 px-3 py-2"
      {...(dataAttribute ? { [dataAttribute]: "true" } : {})}
    >
      <div className="chat-markdown-streaming wrap-break-word whitespace-pre-wrap text-sm leading-relaxed text-foreground/80 [content-visibility:auto]">
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
  text,
  isTransitionPending,
  onRenderMarkdown,
}: {
  text: string;
  isTransitionPending: boolean;
  onRenderMarkdown: () => void;
}) {
  const previewText = useMemo(() => buildLargeMarkdownPreviewText(text), [text]);

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
          {text.length.toLocaleString()} chars
        </span>
      </div>
    </div>
  );
}

function CompletedMarkdownPreview({ text }: { text: string }) {
  return <PreviewTextPanel text={text} dataAttribute="data-deferred-markdown" />;
}

function ChatMarkdown({ text, cwd, isStreaming = false, streamingTextState }: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const [renderPreference, setRenderPreference] = useState<"auto" | "markdown">("auto");
  const [deferredMarkdownReady, setDeferredMarkdownReady] = useState(() => !isStreaming);
  const previousStreamingRef = useRef(isStreaming);
  const [isMarkdownTransitionPending, startMarkdownTransition] = useTransition();
  const useLargePreview =
    !isStreaming &&
    renderPreference !== "markdown" &&
    shouldUseLargeMarkdownPreview(text, streamingTextState?.totalLineCount);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath) {
          return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
        }

        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const api = readNativeApi();
              if (api) {
                void openInPreferredEditor(api, targetPath);
              } else {
                console.warn("Native API not found. Unable to open file in editor.");
              }
            }}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [cwd, diffThemeName, isStreaming],
  );

  useEffect(() => {
    const wasStreaming = previousStreamingRef.current;
    previousStreamingRef.current = isStreaming;

    if (isStreaming) {
      setRenderPreference("auto");
      setDeferredMarkdownReady(false);
      return;
    }

    if (useLargePreview) {
      setDeferredMarkdownReady(false);
      return;
    }

    if (!wasStreaming) {
      setDeferredMarkdownReady(true);
      return;
    }

    setDeferredMarkdownReady(false);
    return scheduleDeferredMarkdownUpgrade(() => {
      startMarkdownTransition(() => {
        setDeferredMarkdownReady(true);
      });
    });
  }, [isStreaming, startMarkdownTransition, useLargePreview]);

  if (isStreaming) {
    return <StreamingMarkdownPreview text={text} streamingTextState={streamingTextState} />;
  }

  if (useLargePreview) {
    return (
      <LargeMarkdownPreview
        text={text}
        isTransitionPending={isMarkdownTransitionPending}
        onRenderMarkdown={() => {
          startMarkdownTransition(() => {
            setRenderPreference("markdown");
          });
        }}
      />
    );
  }

  if (!deferredMarkdownReady) {
    return <CompletedMarkdownPreview text={text} />;
  }

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [content-visibility:auto]">
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
