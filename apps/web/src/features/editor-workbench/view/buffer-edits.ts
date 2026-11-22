import type { TextBuffer } from "../buffers/index.ts";

/*
 * A view's own typing emits no buffer event (`BufferEvent` is for state changes and texts the
 * registry replaced). Views report each edit here, so what follows the text as it is typed (the
 * outline, blame's line mapping) can listen without the buffer notifying everyone per keystroke.
 */
const listeners = new WeakMap<TextBuffer, Set<() => void>>();

/** A view typed into `buffer`. */
export function noteBufferEdited(buffer: TextBuffer): void {
  const heard = listeners.get(buffer);
  if (heard) for (const listener of heard) listener();
}

/** Calls `listener` after each edit a view reports for `buffer`. */
export function onBufferEdits(buffer: TextBuffer, listener: () => void): () => void {
  let heard = listeners.get(buffer);
  if (!heard) {
    heard = new Set();
    listeners.set(buffer, heard);
  }
  heard.add(listener);
  return () => void heard.delete(listener);
}
