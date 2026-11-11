import { withoutMarkerCharacters } from "@ace/ui-core";
import type { ClipboardEvent, DragEvent } from "react";
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
  // A file's marker is the composer's own: a pasted one would be a file that isn't there.
  if (ports.input) insertEditorText(ports.input, withoutMarkerCharacters(pasted));
}

/**
 * Words dropped on the message go in as a paste does, at the drop point, as plain text without
 * any file marker; files are the caller's. False when the drop carries no words.
 */
export function dropTextIntoComposer(
  event: DragEvent<HTMLElement>,
  input: HTMLElement | null,
): boolean {
  const words = event.dataTransfer.getData("text/plain");
  if (!input || !words) return false;
  event.preventDefault();
  const doc = input.ownerDocument;
  input.focus();
  // Where it was dropped, where the browser can say.
  const point =
    "caretRangeFromPoint" in doc ? doc.caretRangeFromPoint(event.clientX, event.clientY) : null;
  if (point && input.contains(point.startContainer)) {
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(point);
  }
  insertEditorText(input, withoutMarkerCharacters(words));
  return true;
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
