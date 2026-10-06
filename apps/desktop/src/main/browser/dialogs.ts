import { z } from "zod";
import type { WebContents } from "electron";
const Request = z.object({
  type: z.enum(["alert", "confirm", "prompt"]),
  message: z.string().max(4096),
  defaultPrompt: z.string().max(4096),
});
const Answer = z.object({ accept: z.boolean(), promptText: z.string().max(4096).optional() });
/** Scoped synchronous replies keep page dialogs in ace, including Electron's missing prompt(). */
export class NativeDialogs {
  private reply: ((accept: boolean, text?: string) => void) | undefined;
  private contents: WebContents;
  constructor(contents: WebContents, emit: (method: string, params: unknown) => void) {
    this.contents = contents;
    contents.ipc.on("ace:browser.dialog", (event, raw: unknown) => {
      const parsed = Request.safeParse(raw);
      if (!parsed.success || this.reply) {
        event.returnValue = null;
        return;
      }
      this.reply = (accept, text) => {
        this.reply = undefined;
        event.returnValue =
          parsed.data.type === "prompt"
            ? accept
              ? (text ?? parsed.data.defaultPrompt)
              : null
            : accept;
        emit("Page.javascriptDialogClosed", { result: accept, userInput: text ?? "" });
      };
      emit("Page.javascriptDialogOpening", {
        url: event.senderFrame?.url ?? contents.getURL(),
        ...parsed.data,
      });
    });
    contents.on("will-navigate", () => this.close());
    contents.on("destroyed", () => this.close());
  }
  answer(method: string, params: unknown): boolean {
    if (method !== "Page.handleJavaScriptDialog" || !this.reply) return false;
    const answer = Answer.parse(params);
    this.reply(answer.accept, answer.promptText);
    return true;
  }
  close() {
    if (this.contents.isDestroyed()) {
      this.reply = undefined;
      return;
    }
    this.reply?.(false);
  }
}
