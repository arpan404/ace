import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon, GlobeIcon } from "lucide-react";
import React, {
  Children,
  Suspense,
  isValidElement,
  startTransition,
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
import { normalizeBrowserHttpUrl } from "../lib/browser/url";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import type { ChatMessageStreamingTextState } from "../types";
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
  isStreaming?: boolean;
  renderPlainText?: boolean;
  streamingTextState?: ChatMessageStreamingTextState;
  deferMarkdownUntilVisible?: boolean;
  onLayoutChange?: () => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void) | null;
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
const MAX_MARKDOWN_ACTIVATION_CACHE_ENTRIES = clampCacheEntryCount(1_000, {
  moderateCapEntries: 640,
  constrainedCapEntries: 320,
});
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const markdownActivationCache = new LRUCache<boolean>(
  MAX_MARKDOWN_ACTIVATION_CACHE_ENTRIES,
  MAX_MARKDOWN_ACTIVATION_CACHE_ENTRIES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const LAZY_MARKDOWN_PREVIEW_MAX_CHARS = 8_000;
const LAZY_MARKDOWN_INTERSECTION_ROOT_MARGIN = "1400px 0px";

registerMemoryPressureHandler({
  id: "markdown-highlight-cache",
  minLevel: "high",
  release: () => {
    highlightedCodeCache.clear();
    markdownActivationCache.clear();
    highlighterPromiseCache.clear();
  },
});

function createMarkdownActivationCacheKey(text: string, cwd: string | undefined): string {
  return `${fnv1a32(text).toString(36)}:${text.length}:${cwd ?? ""}`;
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
      Rendering Mermaid diagram...
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

function MarkdownBody({
  children,
  isStreaming,
  markdownComponents,
}: {
  children: string;
  isStreaming: boolean;
  markdownComponents: Components;
}) {
  return (
    <div
      className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80"
      data-streaming-markdown={isStreaming ? "true" : undefined}
    >
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={markdownComponents}>
        {children}
      </ReactMarkdown>
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
      className="max-h-96 overflow-auto px-0 py-0"
      {...(dataAttribute ? { [dataAttribute]: "true" } : {})}
    >
      <div className="chat-markdown-streaming wrap-break-word whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
        {text}
      </div>
    </div>
  );
}

function buildLazyMarkdownPreviewText(text: string): string {
  if (text.length <= LAZY_MARKDOWN_PREVIEW_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, LAZY_MARKDOWN_PREVIEW_MAX_CHARS)}\n\n[... markdown will render when this message is visible ...]`;
}

function LazyMarkdownPreview({ text }: { text: string }) {
  const previewText = useMemo(() => buildLazyMarkdownPreviewText(text), [text]);
  return <PreviewTextPanel text={previewText} dataAttribute="data-large-markdown-preview" />;
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

function ChatMarkdown({
  text,
  cwd,
  isStreaming = false,
  renderPlainText = false,
  streamingTextState,
  deferMarkdownUntilVisible = false,
  onLayoutChange,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const [renderPreference, setRenderPreference] = useState<"auto" | "markdown">("auto");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isMarkdownTransitionPending, startMarkdownTransition] = useTransition();
  const markdownActivationCacheKey = useMemo(
    () => createMarkdownActivationCacheKey(text, cwd),
    [cwd, text],
  );
  const [markdownActivated, setMarkdownActivated] = useState(
    () =>
      !deferMarkdownUntilVisible ||
      typeof IntersectionObserver === "undefined" ||
      markdownActivationCache.get(markdownActivationCacheKey) === true,
  );
  const useLargePreview =
    !isStreaming &&
    renderPreference !== "markdown" &&
    shouldUseLargeMarkdownPreview(text, streamingTextState?.totalLineCount);
  const shouldDeferMarkdown =
    deferMarkdownUntilVisible &&
    !markdownActivated &&
    !isStreaming &&
    !renderPlainText &&
    !useLargePreview;
  const openLinkExternally = useCallback((href: string) => {
    const api = readNativeApi();
    if (api) {
      void api.shell.openExternal(href).catch((error) => {
        console.warn("Failed to open link externally.", error);
      });
      return;
    }
    window.open(href, "_blank", "noopener,noreferrer");
  }, []);

  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath) {
          const browserUrl = href ? normalizeBrowserHttpUrl(href) : null;
          if (!browserUrl || !onOpenBrowserUrl) {
            return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
          }

          return (
            <span className="chat-markdown-link-shell">
              <a
                {...props}
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.metaKey || event.ctrlKey) {
                    openLinkExternally(href ?? browserUrl);
                    return;
                  }
                  onOpenBrowserUrl(browserUrl);
                }}
              />
              <button
                type="button"
                className="chat-markdown-link-open-browser"
                aria-label="Open link in the in-app browser"
                title="Open in in-app browser"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenBrowserUrl(browserUrl);
                }}
              >
                <GlobeIcon className="size-3" />
              </button>
            </span>
          );
        }

        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.metaKey || event.ctrlKey) {
                const api = readNativeApi();
                if (api) {
                  void openInPreferredEditor(api, targetPath).catch((error) => {
                    console.warn("Failed to open file in external editor.", error);
                  });
                } else {
                  console.warn("Native API not found. Unable to open file in external editor.");
                }
                return;
              }
              if (onOpenFilePath) {
                onOpenFilePath(targetPath);
                return;
              }
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
    [
      cwd,
      diffThemeName,
      isStreaming,
      onOpenBrowserUrl,
      onOpenFilePath,
      openLinkExternally,
      resolvedTheme,
    ],
  );
  useEffect(() => {
    if (isStreaming) {
      setRenderPreference("auto");
    }
  }, [isStreaming]);

  useEffect(() => {
    if (!deferMarkdownUntilVisible || typeof IntersectionObserver === "undefined") {
      setMarkdownActivated(true);
      return;
    }
    if (markdownActivationCache.get(markdownActivationCacheKey) === true) {
      setMarkdownActivated(true);
      return;
    }
    setMarkdownActivated(false);
  }, [deferMarkdownUntilVisible, markdownActivationCacheKey]);

  useEffect(() => {
    if (!shouldDeferMarkdown) {
      return;
    }
    const rootElement = rootRef.current;
    if (!rootElement || typeof IntersectionObserver === "undefined") {
      setMarkdownActivated(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
          return;
        }
        observer.disconnect();
        markdownActivationCache.set(markdownActivationCacheKey, true, 1);
        startTransition(() => {
          setMarkdownActivated(true);
        });
      },
      { root: null, rootMargin: LAZY_MARKDOWN_INTERSECTION_ROOT_MARGIN },
    );
    observer.observe(rootElement);

    return () => {
      observer.disconnect();
    };
  }, [markdownActivationCacheKey, shouldDeferMarkdown]);

  useEffect(() => {
    onLayoutChange?.();
  }, [isStreaming, markdownActivated, onLayoutChange, renderPreference, text, useLargePreview]);

  useEffect(() => {
    if (!onLayoutChange || typeof ResizeObserver === "undefined") {
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
  }, [onLayoutChange]);

  let content: ReactNode;
  if (renderPlainText) {
    content = <PreviewTextPanel text={text} />;
  } else if (shouldDeferMarkdown) {
    content = <LazyMarkdownPreview text={text} />;
  } else if (
    isStreaming &&
    streamingTextState &&
    (streamingTextState.truncatedCharCount > 0 || streamingTextState.truncatedLineCount > 0)
  ) {
    content = <StreamingMarkdownPreview text={text} streamingTextState={streamingTextState} />;
  } else if (useLargePreview) {
    content = (
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
  } else {
    content = (
      <MarkdownBody isStreaming={isStreaming} markdownComponents={markdownComponents}>
        {text}
      </MarkdownBody>
    );
  }

  return (
    <div ref={rootRef} className="w-full min-w-0">
      {content}
    </div>
  );
}

export default memo(ChatMarkdown);
