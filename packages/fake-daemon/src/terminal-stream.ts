import type { TerminalOutput } from "@ace/protocol";
import type { FakeTerminals } from "./terminals.ts";
/** A credit wakes a ring reader; blocked viewers retain no pending output objects. */
export class FakeTerminalStream {
  private terminals: FakeTerminals;
  private id: string;
  private offset: number;
  private emit: (event: TerminalOutput["event"]) => void;
  private allowed: () => boolean;
  private detach: () => void;
  private ended: (() => void) | undefined;
  private available = false;
  private stopped = false;
  constructor(
    terminals: FakeTerminals,
    id: string,
    offset: number,
    emit: (event: TerminalOutput["event"]) => void,
    allowed: () => boolean,
    ended?: () => void,
  ) {
    this.terminals = terminals;
    this.id = id;
    this.offset = offset;
    this.emit = emit;
    this.allowed = allowed;
    this.ended = ended;
    this.detach = terminals.attach(id, terminals.offsets(id).nextOffset, () => this.pump());
  }
  credit(): void {
    this.available = true;
    this.pump();
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.detach();
    this.ended?.();
  }
  private pump(): void {
    if (this.stopped || !this.available) return;
    if (!this.allowed()) {
      this.stop();
      return;
    }
    const event = this.terminals.readEvent(this.id, this.offset);
    if (!event) return;
    this.available = false;
    if (event.type === "data") this.offset = event.endOffset;
    this.emit(
      event.type === "exit"
        ? { type: "exit", nextOffset: event.nextOffset, status: { code: event.code, signal: null } }
        : event,
    );
    if (event.type !== "data") this.stop();
  }
}
