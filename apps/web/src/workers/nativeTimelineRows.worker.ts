import {
  buildNativeTimelineRows,
  type NativeTimelineRowsInput,
} from "../lib/chat/nativeTimelineRows";

interface NativeTimelineRowsWorkerRequest {
  readonly id: number;
  readonly input: NativeTimelineRowsInput;
}

interface NativeTimelineRowsWorkerResponse {
  readonly id: number;
  readonly rows?: ReturnType<typeof buildNativeTimelineRows>;
  readonly error?: string;
}

interface NativeTimelineRowsWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<NativeTimelineRowsWorkerRequest>) => void,
  ): void;
  postMessage(message: NativeTimelineRowsWorkerResponse, transfer: Transferable[]): void;
}

const workerScope = self as unknown as NativeTimelineRowsWorkerScope;

function postNativeTimelineRowsWorkerResponse(response: NativeTimelineRowsWorkerResponse): void {
  workerScope.postMessage(response, []);
}

workerScope.addEventListener("message", (event) => {
  const { id, input } = event.data;
  try {
    const rows = buildNativeTimelineRows(input);
    postNativeTimelineRowsWorkerResponse({ id, rows });
  } catch (error) {
    postNativeTimelineRowsWorkerResponse({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
