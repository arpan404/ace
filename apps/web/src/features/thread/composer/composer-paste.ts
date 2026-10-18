import type { ClipboardEvent } from "react";
import { insertEditorText } from "./editor-dom.ts";
import { pastedFile } from "./large-paste.ts";

/**
 * Paste into the message: files attach, a long text (a log, a file's worth) goes along as a text
 * file instead of flooding the message, and anything else goes in as plain text.
 */
export function pasteIntoComposer(
  event: ClipboardEvent<HTMLElement>,
  ports: {
    input: HTMLElement | null;
    intake(data: DataTransfer): void;
    attach(files: File[]): void;
  },
): void {
  event.preventDefault();
  if (event.clipboardData.files.length) return ports.intake(event.clipboardData);
  const pasted = event.clipboardData.getData("text/plain");
  const file = pastedFile(pasted);
  if (file) return ports.attach([new File([pasted], file.name, { type: "text/plain" })]);
  if (ports.input) insertEditorText(ports.input, pasted);
}

/** Why the message can't go yet, in words; undefined when it can. Pure. */
export function sendBlockedReason(state: {
  off: string | undefined;
  sendBlocked: string | undefined;
  uploading: boolean;
  sendsWhileUploading: boolean;
  failedUpload: boolean;
  empty: boolean;
}): string | undefined {
  if (state.off || state.sendBlocked) return state.off ?? state.sendBlocked;
  if (state.uploading && !state.sendsWhileUploading) return "Waiting for the files to upload";
  if (state.failedUpload) return "Remove the file that didn't upload first";
  return state.empty ? "Write a message first" : undefined;
}
