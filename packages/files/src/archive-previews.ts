import type { SafeRoot } from "@ace/workspace";
import type { FileOperation } from "@ace/protocol";
import { archiveDownload, previewArchive, type Preview } from "./archive.ts";
import { newId } from "./filesystem.ts";
import { FileError, type FilesOptions } from "./types.ts";
import type { FileRequestLifetime } from "./request-lifetime.ts";

export class ArchivePreviews {
  private readonly entries = new Map<string, Preview>();
  private scanning = 0;
  private readonly safe: SafeRoot;
  private readonly options: FilesOptions;
  private readonly lifetime: FileRequestLifetime;
  constructor(safe: SafeRoot, options: FilesOptions, lifetime: FileRequestLifetime) {
    this.safe = safe;
    this.options = options;
    this.lifetime = lifetime;
  }
  async preview(operation: Extract<FileOperation, { op: "archive.preview" }>) {
    this.sweep();
    if (this.entries.size + this.scanning >= 4)
      throw new FileError("BUSY", "Archive preview limit reached");
    this.scanning++;
    let preview: Preview;
    try {
      preview = await this.lifetime.walk((signal) =>
        previewArchive(
          this.safe,
          operation.path,
          operation.includeIgnored,
          newId(this.options.id),
          this.options.now() + 300_000,
          signal,
        ),
      );
    } finally {
      this.scanning--;
    }
    this.entries.set(preview.id, preview);
    return {
      previewId: preview.id,
      bytes: preview.bytes,
      entries: preview.entries.length,
      format: "tar.gz",
      validator: preview.validator,
    };
  }
  download(id: string) {
    const preview = this.entries.get(id);
    if (!preview || preview.expires <= this.options.now())
      throw new FileError("EXPIRED", "Archive preview expired");
    return archiveDownload(this.safe, preview);
  }
  sweep(): void {
    for (const [id, preview] of this.entries)
      if (preview.expires <= this.options.now()) this.entries.delete(id);
  }
  close(): void {
    this.entries.clear();
  }
}
