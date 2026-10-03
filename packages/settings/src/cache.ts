import { SettingsError } from "./validation.ts";
import type { SettingsFile } from "./file.ts";

export interface FileLease {
  file: SettingsFile;
  release(): void;
}
interface Entry {
  file: SettingsFile;
  ready: Promise<void>;
  refs: number;
}
/** Bounded LRU. Live operations, subscriptions and unhealthy files never get evicted. */
export class FileCache {
  private entries = new Map<string, Entry>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private async lease(path: string, entry: Entry): Promise<FileLease> {
    entry.refs++;
    this.entries.delete(path);
    this.entries.set(path, entry);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        entry.refs--;
      }
    };
    try {
      await entry.ready;
      if (this.closed) throw new SettingsError("io", "Settings service is closed");
    } catch (error) {
      release();
      throw error;
    }
    return { file: entry.file, release };
  }
  acquire(path: string, create: () => Promise<SettingsFile>): Promise<FileLease> {
    if (this.closed) return Promise.reject(new SettingsError("io", "Settings service is closed"));
    const cached = this.entries.get(path);
    if (cached) return this.lease(path, cached);
    if (this.pending >= 64)
      return Promise.reject(new SettingsError("limit", "Settings scope queue is full"));
    this.pending++;
    const result = this.tail.then(async () => {
      if (this.closed) throw new SettingsError("io", "Settings service is closed");
      const existing = this.entries.get(path);
      if (existing) return this.lease(path, existing);
      if (this.entries.size >= 64) {
        const inactive = [...this.entries].find(
          ([, entry]) => entry.refs === 0 && !entry.file.diagnostic,
        );
        if (!inactive)
          throw new SettingsError(
            "limit",
            "Settings file limit reached; release active subscriptions or repair invalid scopes",
          );
        this.entries.delete(inactive[0]);
        await inactive[1].file.close();
      }
      const file = await create();
      if (this.closed) {
        await file.close();
        throw new SettingsError("io", "Settings service is closed");
      }
      const entry = { file, ready: file.reload(), refs: 0 };
      this.entries.set(path, entry);
      return this.lease(path, entry);
    });
    this.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.pending--;
      });
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await Promise.all([...this.entries.values()].map(({ file }) => file.close()));
    this.entries.clear();
  }
}
