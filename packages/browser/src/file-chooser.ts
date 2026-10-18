import { z } from "zod";
import type { BrowserFileChooser } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";

const Opened = z.object({
  mode: z.enum(["selectSingle", "selectMultiple"]),
  backendNodeId: z.number().int().optional(),
});
const Navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) });

/**
 * A tab's file picker, intercepted (`Page.setInterceptFileChooserDialog`): a headless browser
 * has no picker of its own, so the person picks files on their device and they are set on the
 * input (`DOM.setFileInputFiles`). Agents get a log hint to use `upload` with the input's ref.
 * A newer picker replaces an older one; a committed page ends it.
 */
export class FileChooserPrompt {
  private pending: { chooser: BrowserFileChooser; backendNodeId?: number | undefined } | undefined;
  private cdp: BrowserCdp;
  private stops: (() => void)[] = [];
  constructor(
    cdp: BrowserCdp,
    tabId: string,
    id: () => string,
    events: { changed(): void; opened(): void },
  ) {
    this.cdp = cdp;
    const opened = (raw: unknown) => {
      const parsed = Opened.safeParse(raw);
      if (!parsed.success) return;
      this.pending = {
        chooser: {
          chooserId: `${tabId}-files-${id()}`,
          tabId,
          multiple: parsed.data.mode === "selectMultiple",
        },
        backendNodeId: parsed.data.backendNodeId,
      };
      events.opened();
      events.changed();
    };
    const navigated = (raw: unknown) => {
      const frame = Navigated.safeParse(raw);
      if (!frame.success || frame.data.frame.parentId || !this.pending) return;
      this.pending = undefined;
      events.changed();
    };
    cdp.on("Page.fileChooserOpened", opened);
    cdp.on("Page.frameNavigated", navigated);
    this.stops.push(
      () => cdp.off("Page.fileChooserOpened", opened),
      () => cdp.off("Page.frameNavigated", navigated),
    );
    this.changed = events.changed;
  }
  private changed: () => void;
  chooser(): BrowserFileChooser | undefined {
    return this.pending?.chooser;
  }
  /** The person's files for the open picker; none cancels it and leaves the input as it was. */
  async choose(chooserId: string, paths: readonly string[]): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.chooser.chooserId !== chooserId)
      throw new Error("File picker no longer open");
    this.pending = undefined;
    this.changed();
    if (!paths.length) return;
    if (pending.backendNodeId === undefined) throw new Error("The file input is gone");
    await this.cdp.send("DOM.setFileInputFiles", {
      files: pending.chooser.multiple ? [...paths] : paths.slice(0, 1),
      backendNodeId: pending.backendNodeId,
    });
  }
  forget(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.changed();
  }
  close(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.pending = undefined;
  }
}
