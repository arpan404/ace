export const CHUNK_SIZE = 64 * 1024;
export const MAX_CREDITS = 8;
export class FileError extends Error {
  readonly code: string;
  readonly current: string | null | undefined;
  /** Where an entry that could not be put back is preserved, when the port says so. */
  readonly recovery: string | null | undefined;
  constructor(code: string, message: string, current?: string | null, recovery?: string | null) {
    super(message);
    this.code = code;
    this.current = current;
    this.recovery = recovery;
  }
}
