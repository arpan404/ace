// Temporary ADR 0007 boundary; replaced by @ace/engine-api when foundations lands.
import type { Fact, Key } from "@ace/core";
import type { ContentPart, InteractionResolution, ThreadId } from "@ace/protocol";
export interface Frame {
  seq: number;
  t: number;
  dir: "send" | "recv" | "stderr" | "note";
  channel: string;
  data: unknown;
}
export interface Translator {
  translate(frame: Frame, now: number): Fact[];
  tick(now: number): Fact[];
}
export interface SessionContext {
  threadId: ThreadId;
  cwd: string;
  model?: string;
  resume?: { nativeSessionId: string };
  onFrame(frame: Frame): void;
  onExit(exit: { deliberate: boolean; message?: string }): void;
  signal: AbortSignal;
}
export interface ProviderSession {
  readonly nativeSessionId: string;
  send(input: ContentPart[], delivery: "steer" | "queue"): Promise<void>;
  interrupt(target: { agent?: Key; cascade: boolean }): Promise<void>;
  resolve(interaction: Key, resolution: InteractionResolution): Promise<void>;
  stopTask(task: Key): Promise<void>;
  close(reason: "idle" | "user" | "shutdown"): Promise<void>;
}
