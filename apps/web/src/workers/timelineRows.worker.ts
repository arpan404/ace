import { buildTimelineRows, type BuildTimelineRowsInput } from "../lib/chat/timelineRows";
import { TIMELINE_ROWS_PROJECTION_VERSION } from "../lib/chat/timelineRowsProjection";

interface TimelineRowsWorkerRequest {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly projectionVersion: number;
  readonly input: BuildTimelineRowsInput;
}

addEventListener("message", (event: MessageEvent<TimelineRowsWorkerRequest>) => {
  const request = event.data;
  try {
    const rows = buildTimelineRows(request.input);
    self["postMessage"]({
      requestId: request.requestId,
      cacheKey: request.cacheKey,
      projectionVersion: TIMELINE_ROWS_PROJECTION_VERSION,
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
