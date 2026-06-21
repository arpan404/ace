import {
  buildSourceTimelineRows,
  type SourceTimelineRowsInput,
} from "../lib/chat/sourceTimelineRows";

interface SourceTimelineRowsWorkerRequest {
  readonly id: number;
  readonly input: SourceTimelineRowsInput;
}

interface SourceTimelineRowsWorkerResponse {
  readonly id: number;
  readonly rows?: ReturnType<typeof buildSourceTimelineRows>;
  readonly error?: string;
}

interface SourceTimelineRowsWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<SourceTimelineRowsWorkerRequest>) => void,
  ): void;
  postMessage(message: SourceTimelineRowsWorkerResponse, transfer: Transferable[]): void;
}

const workerScope = self as unknown as SourceTimelineRowsWorkerScope;

function postSourceTimelineRowsWorkerResponse(response: SourceTimelineRowsWorkerResponse): void {
  workerScope.postMessage(response, []);
}

workerScope.addEventListener("message", (event) => {
  const { id, input } = event.data;
  try {
    const rows = buildSourceTimelineRows(input);
    postSourceTimelineRowsWorkerResponse({ id, rows });
  } catch (error) {
    postSourceTimelineRowsWorkerResponse({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
