import type { FilesServerMessage } from "@ace/protocol";

/** Authenticated byte transport. The owner must cap queues and await binary writes. */
export interface FilesTransport {
  readonly isOpen: boolean;
  readonly bufferedBytes: number;
  sendControl(message: FilesServerMessage): Promise<void>;
  sendBinary(frame: Buffer): Promise<void>;
  onClose(listener: () => void): () => void;
  close(): void;
}

/** Destination-owned persistence and quota policy, shared with attachment blob uploads. */
export interface BinaryUploadDestination {
  uploadId: string;
  offset: number;
  size: number;
  append(
    offset: number,
    bytes: Buffer,
    assertAuthorized: () => void,
  ): Promise<{ uploadId: string; offset: number; size: number }>;
}
