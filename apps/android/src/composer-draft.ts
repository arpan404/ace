import type { Selection } from "@ace/client";

export interface DraftValue {
  readonly text: string;
  readonly saving: boolean;
}
/** UI-owned editing state. The injected submit port owns persistence and command correctness. */
export class ComposerDraft {
  #value: DraftValue = { text: "", saving: false };
  #revision = 0;
  #listeners = new Set<() => void>();
  #submit: (text: string) => Promise<unknown>;
  readonly selection: Selection<DraftValue> = {
    getSnapshot: () => this.#value,
    subscribe: (listener) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };
  constructor(submit: (text: string) => Promise<unknown>) {
    this.#submit = submit;
  }
  edit(text: string): void {
    this.#revision++;
    this.#publish({ text, saving: this.#value.saving });
  }
  async send(): Promise<"saved" | "empty"> {
    if (!this.#value.text.trim() || this.#value.saving) return "empty";
    const revision = this.#revision,
      submitted = this.#value.text;
    this.#publish({ text: submitted, saving: true });
    try {
      await this.#submit(submitted);
      this.#publish({ text: this.#revision === revision ? "" : this.#value.text, saving: false });
      return "saved";
    } catch (error) {
      this.#publish({ text: this.#value.text, saving: false });
      throw error;
    }
  }
  #publish(value: DraftValue) {
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }
}
