/*
 * Image bytes on their way to the phone, a budget at a time: every thumbnail and picture the
 * bridge reads for Swift (a thread's attachments, Spade's images) counts against one cap, so a
 * screen scrolled past many large pictures reads them a few at a time instead of all at once.
 */

/** Base64 the phone's image reads may hold in flight at once: a dozen previews, or two originals. */
export const imageBudgetBytes = 16 * 1024 * 1024;

/**
 * Reads that hold at most `cap` bytes between them, each counted at the most it may bring. They
 * start in the order they came; one larger than the cap runs once nothing else is in flight.
 */
export class ImageBudget {
  private held = 0;
  private readonly cap: number;
  private readonly waiting: { bytes: number; start: () => void }[] = [];
  constructor(cap: number) {
    this.cap = cap;
  }

  async run<T>(bytes: number, read: () => Promise<T>): Promise<T> {
    // A read's bytes are counted the moment it is let in, whether at once or from the line.
    if (this.waiting.length || !this.fits(bytes))
      await new Promise<void>((start) => this.waiting.push({ bytes, start }));
    else this.held += bytes;
    try {
      return await read();
    } finally {
      this.held -= bytes;
      this.letIn();
    }
  }

  private fits(bytes: number) {
    return this.held === 0 || this.held + bytes <= this.cap;
  }

  private letIn() {
    for (let next = this.waiting[0]; next && this.fits(next.bytes); next = this.waiting[0]) {
      this.waiting.shift();
      this.held += next.bytes;
      next.start();
    }
  }
}
