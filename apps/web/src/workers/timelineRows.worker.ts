import { buildTimelineRows, type BuildTimelineRowsInput } from "../lib/chat/timelineRows";

interface TimelineRowsWorkerRequest {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly input: BuildTimelineRowsInput;
}

addEventListener("message", (event: MessageEvent<TimelineRowsWorkerRequest>) => {
  const request = event.data;
  try {
    const rows = buildTimelineRows(request.input);
    self["postMessage"]({
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      input: request.input,
      rows,
    });
  } catch (error) {
    self["postMessage"]({
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      error: error instanceof Error ? error.message : "Timeline row build failed.",
    });
  }
});
