import { BrowserFeaturesClient, type ClientCore } from "@ace/client";
import type { ThreadId } from "@ace/protocol";
import type { PatchSink } from "./agents.ts";
import {
  AttachmentTray,
  type ChunkReader,
  type Picked,
  type TrayRow,
} from "./thread-attachments.ts";

/*
 * A page's file picker answered from the phone: the picked files upload as the thread's
 * attachments (the same resumable upload the composer uses), then go to the page's input. No
 * files cancels the picker.
 */

interface ChooserHost {
  owner: Pick<ClientCore, "request">;
  sink: PatchSink;
  read: ChunkReader;
}

export class BrowserChooser {
  #host: ChooserHost;
  #problem: (message: string) => void;
  #abort: AbortController | undefined;
  constructor(host: ChooserHost, problem: (message: string) => void) {
    this.#host = host;
    this.#problem = problem;
  }
  choose(threadId: ThreadId, tabId: string, chooserId: string, files: readonly Picked[]): void {
    this.close();
    if (!files.length) {
      void this.#send(threadId, tabId, chooserId, []);
      return;
    }
    const abort = new AbortController();
    this.#abort = abort;
    let done = false;
    const emit = (rows: TrayRow[]) => {
      if (done || abort.signal.aborted || rows.length !== files.length) return;
      const failed = rows.find((row) => row.state === "failed");
      if (failed) {
        done = true;
        this.#problem(`Couldn't upload ${String(failed.name)}. ${String(failed.error)}`.trim());
        void this.#send(threadId, tabId, chooserId, []);
        this.#host.sink.clear("browser:upload");
        return;
      }
      const ready = rows.filter((row) => row.state === "ready").length;
      if (ready < rows.length) {
        const progress =
          rows.reduce((sum, row) => sum + Number(row.progress ?? 0), 0) / rows.length;
        this.#host.sink.put("browser:upload", () => ({
          type: "browser.upload",
          chooserId,
          progress,
        }));
        return;
      }
      done = true;
      this.#host.sink.clear("browser:upload");
      void this.#send(threadId, tabId, chooserId, files);
    };
    const tray = new AttachmentTray(
      this.#host.owner,
      { threadId },
      abort.signal,
      emit,
      this.#host.read,
    );
    // Any file goes to a page; what an agent can read doesn't apply.
    for (const file of files) tray.attach(file, undefined);
  }
  close(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.#host.sink.clear("browser:upload");
  }
  async #send(threadId: ThreadId, tabId: string, chooserId: string, files: readonly Picked[]) {
    try {
      await new BrowserFeaturesClient(this.#host.owner).chooseFiles(
        threadId,
        tabId,
        chooserId,
        files.map((file) => ({ sha256: file.sha256, name: file.name })),
      );
    } catch (error) {
      this.#problem(
        `Couldn't give the page your files. ${error instanceof Error ? error.message : ""}`.trim(),
      );
    }
  }
}
