/** A cancelled transport keeps its transfer reservation until the last append settles. */
export async function drainUpload(upload: {
  pending?: Promise<unknown>;
  release(): void;
}): Promise<void> {
  try {
    await upload.pending;
  } catch {
    // The append owner reports its error. Cleanup still releases the drained reservation.
  } finally {
    upload.release();
  }
}
