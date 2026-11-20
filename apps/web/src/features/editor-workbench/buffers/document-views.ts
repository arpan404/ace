import type { EditorDocument } from "@ace/editor";
import type { DocumentView } from "@/features/editor";
import type { BufferView } from "./types.ts";

/**
 * One document's mounted views, and when it is freed. A document the buffer lets go of while
 * views still show it (a re-read replacing it, Don't save) is freed only once the last of them
 * has detached, so none of their renders, typing runs or effects reaches freed Wasm memory.
 */
export class DocumentViews implements BufferView {
  readonly doc: EditorDocument;
  readonly #mounted: DocumentView[] = [];
  #released = false;
  #freed = false;

  constructor(doc: EditorDocument) {
    this.doc = doc;
  }

  attach(view: DocumentView): () => void {
    if (this.#freed) return () => {};
    this.#mounted.push(view);
    return () => {
      const index = this.#mounted.lastIndexOf(view);
      if (index >= 0) this.#mounted.splice(index, 1);
      this.#settle();
    };
  }

  views(): readonly DocumentView[] {
    return this.#mounted;
  }

  /** The buffer is done with the document: freed now, or once its last view detaches. */
  release(): void {
    this.#released = true;
    this.#settle();
  }

  #settle(): void {
    if (!this.#released || this.#freed || this.#mounted.length > 0) return;
    this.#freed = true;
    this.doc.dispose();
  }
}
