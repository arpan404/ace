import {
  analyzeMarkdownRender,
  type MarkdownRenderAnalysisInput,
} from "../lib/chat/markdownRenderAnalysis";

interface MarkdownRenderAnalysisWorkerRequest {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly input: MarkdownRenderAnalysisInput;
}

addEventListener("message", (event: MessageEvent<MarkdownRenderAnalysisWorkerRequest>) => {
  const request = event.data;
  try {
    const result = analyzeMarkdownRender(request.input);
    self["postMessage"]({
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      input: request.input,
      result,
    });
  } catch (error) {
    self["postMessage"]({
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      error: error instanceof Error ? error.message : "Markdown analysis failed.",
    });
  }
});
