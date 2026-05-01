import MarkdownRenderAnalysisWorker from "../../workers/markdownRenderAnalysis.worker?worker";
import { LRUCache } from "../lruCache";
import { registerMemoryPressureHandler, shouldBypassNonEssentialCaching } from "../memoryPressure";
import { clampCacheBudgetBytes, clampCacheEntryCount } from "../resourceProfile";
import {
  analyzeMarkdownRender,
  type MarkdownRenderAnalysisInput,
  type MarkdownRenderAnalysisResult,
} from "./markdownRenderAnalysis";

const MAX_MARKDOWN_ANALYSIS_CACHE_ENTRIES = clampCacheEntryCount(768, {
  moderateCapEntries: 480,
  constrainedCapEntries: 240,
});
const MAX_MARKDOWN_ANALYSIS_CACHE_MEMORY_BYTES = clampCacheBudgetBytes(24 * 1024 * 1024, {
  moderateCapBytes: 12 * 1024 * 1024,
  constrainedCapBytes: 6 * 1024 * 1024,
});

interface MarkdownRenderAnalysisWorkerRequest {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly input: MarkdownRenderAnalysisInput;
}

interface MarkdownRenderAnalysisWorkerSuccess {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly input: MarkdownRenderAnalysisInput;
  readonly result: MarkdownRenderAnalysisResult;
}

interface MarkdownRenderAnalysisWorkerFailure {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly error: string;
}

type MarkdownRenderAnalysisWorkerResponse =
  | MarkdownRenderAnalysisWorkerSuccess
  | MarkdownRenderAnalysisWorkerFailure;

const markdownRenderAnalysisCache = new LRUCache<MarkdownRenderAnalysisResult>(
  MAX_MARKDOWN_ANALYSIS_CACHE_ENTRIES,
  MAX_MARKDOWN_ANALYSIS_CACHE_MEMORY_BYTES,
);
const inflightMarkdownRenderAnalysisByCacheKey = new Map<
  string,
  Promise<MarkdownRenderAnalysisResult>
>();
const pendingMarkdownRenderAnalysisByRequestId = new Map<
  number,
  {
    readonly resolve: (result: MarkdownRenderAnalysisResult) => void;
    readonly reject: (reason?: unknown) => void;
  }
>();

let markdownRenderAnalysisWorker: Worker | null | undefined;
let nextMarkdownRenderAnalysisRequestId = 1;

registerMemoryPressureHandler({
  id: "markdown-analysis-cache",
  minLevel: "high",
  release: () => {
    markdownRenderAnalysisCache.clear();
    inflightMarkdownRenderAnalysisByCacheKey.clear();
    pendingMarkdownRenderAnalysisByRequestId.clear();
    markdownRenderAnalysisWorker?.terminate();
    markdownRenderAnalysisWorker = undefined;
  },
});

function estimateMarkdownRenderAnalysisSize(
  input: MarkdownRenderAnalysisInput,
  result: MarkdownRenderAnalysisResult,
): number {
  return Math.max(
    256,
    result.largePreviewText ? result.largePreviewText.length * 2 : 0,
    Math.min(input.text.length, 8_192) * 2,
  );
}

function getMarkdownRenderAnalysisWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }
  if (markdownRenderAnalysisWorker === undefined) {
    const worker = new MarkdownRenderAnalysisWorker();
    worker.addEventListener(
      "message",
      (event: MessageEvent<MarkdownRenderAnalysisWorkerResponse>) => {
        const response = event.data;
        const pending = pendingMarkdownRenderAnalysisByRequestId.get(response.requestId);
        if (!pending) {
          return;
        }
        pendingMarkdownRenderAnalysisByRequestId.delete(response.requestId);
        if ("error" in response) {
          pending.reject(new Error(response.error));
          return;
        }
        markdownRenderAnalysisCache.set(
          response.cacheKey,
          response.result,
          estimateMarkdownRenderAnalysisSize(response.input, response.result),
        );
        pending.resolve(response.result);
      },
    );
    worker.addEventListener("error", (event) => {
      for (const pending of pendingMarkdownRenderAnalysisByRequestId.values()) {
        pending.reject(event.error ?? new Error("Markdown analysis worker failed."));
      }
      pendingMarkdownRenderAnalysisByRequestId.clear();
      inflightMarkdownRenderAnalysisByCacheKey.clear();
      worker.terminate();
      markdownRenderAnalysisWorker = undefined;
    });
    markdownRenderAnalysisWorker = worker;
  }
  return markdownRenderAnalysisWorker;
}

export function readCachedMarkdownRenderAnalysis(
  cacheKey: string,
): MarkdownRenderAnalysisResult | null {
  return markdownRenderAnalysisCache.get(cacheKey);
}

export function requestMarkdownRenderAnalysis(
  cacheKey: string,
  input: MarkdownRenderAnalysisInput,
): Promise<MarkdownRenderAnalysisResult> {
  const cached = readCachedMarkdownRenderAnalysis(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  const inflight = inflightMarkdownRenderAnalysisByCacheKey.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const worker = getMarkdownRenderAnalysisWorker();
  if (!worker || shouldBypassNonEssentialCaching()) {
    const fallbackResult = analyzeMarkdownRender(input);
    if (!shouldBypassNonEssentialCaching()) {
      markdownRenderAnalysisCache.set(
        cacheKey,
        fallbackResult,
        estimateMarkdownRenderAnalysisSize(input, fallbackResult),
      );
    }
    return Promise.resolve(fallbackResult);
  }

  const requestId = nextMarkdownRenderAnalysisRequestId++;
  const promise = new Promise<MarkdownRenderAnalysisResult>((resolve, reject) => {
    pendingMarkdownRenderAnalysisByRequestId.set(requestId, {
      resolve,
      reject,
    });
    worker["postMessage"]({
      requestId,
      cacheKey,
      input,
    } satisfies MarkdownRenderAnalysisWorkerRequest);
  }).finally(() => {
    inflightMarkdownRenderAnalysisByCacheKey.delete(cacheKey);
  });

  inflightMarkdownRenderAnalysisByCacheKey.set(cacheKey, promise);
  return promise;
}

export function prewarmMarkdownRenderAnalysis(
  cacheKey: string,
  input: MarkdownRenderAnalysisInput,
): void {
  if (readCachedMarkdownRenderAnalysis(cacheKey)) {
    return;
  }
  void requestMarkdownRenderAnalysis(cacheKey, input).catch(() => {
    const fallbackResult = analyzeMarkdownRender(input);
    if (!shouldBypassNonEssentialCaching()) {
      markdownRenderAnalysisCache.set(
        cacheKey,
        fallbackResult,
        estimateMarkdownRenderAnalysisSize(input, fallbackResult),
      );
    }
  });
}
