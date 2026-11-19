/**
 * Uploads committed lately, kept as the daemon keeps them: for a day after a commit, resuming
 * the upload answers COMMITTED and committing it again returns the first commit's result, so a
 * client whose commit reply was lost learns the file is in place. At most `limit` are kept.
 */
export interface UploadReceipt {
  device: string;
  threadId: string;
  sha256: string;
  value: unknown;
}

const dayMs = 86_400_000;

export class UploadReceipts {
  readonly #now: () => number;
  readonly #limit: number;
  readonly #receipts = new Map<string, UploadReceipt & { expires: number }>();
  constructor(now: () => number, limit = 64) {
    this.#now = now;
    this.#limit = limit;
  }

  add(uploadId: string, receipt: UploadReceipt): void {
    this.#receipts.set(uploadId, { ...receipt, expires: this.#now() + dayMs });
    for (const oldest of this.#receipts.keys()) {
      if (this.#receipts.size <= this.#limit) break;
      this.#receipts.delete(oldest);
    }
  }

  /** The upload's receipt while it is fresh; an expired one is forgotten. */
  get(uploadId: string): UploadReceipt | undefined {
    const receipt = this.#receipts.get(uploadId);
    if (!receipt) return undefined;
    if (receipt.expires > this.#now()) return receipt;
    this.#receipts.delete(uploadId);
    return undefined;
  }
}
