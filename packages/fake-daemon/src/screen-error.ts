import type { ScreenError } from "@ace/protocol";

/** A refusal with the daemon's screen error code, and the holder of a busy target. */
export class FakeScreenError extends Error {
  readonly code: ScreenError["code"];
  readonly holder: { sessionId: string; owner: string } | undefined;
  constructor(
    code: ScreenError["code"],
    message: string,
    holder?: { sessionId: string; owner: string },
  ) {
    super(message);
    this.code = code;
    this.holder = holder;
  }
}
