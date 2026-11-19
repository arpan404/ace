/**
 * The thread is moving or moved to another machine (ADR 0191): no provider opens for it. A send
 * that meets this goes back to the queue, held, never failed.
 */
export class SessionFenced extends Error {
  constructor() {
    super("This thread is moving to another machine; nothing more runs here");
  }
}
