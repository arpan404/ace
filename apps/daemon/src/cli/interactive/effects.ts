import type { CommandPayload } from "@ace/protocol";

/**
 * What a key press asks the shell to do (ADR 0178 §9). The models are pure reducers that
 * return these; `app.ts` carries them out against the daemon and the terminal.
 */
export type Place = "projects" | "spade" | "market" | "settings" | "help";

export type Effect =
  /** Send one command through the client's outbox, with its own idempotency key. */
  | { kind: "command"; payload: CommandPayload; done: string }
  | { kind: "home" }
  | { kind: "requests" }
  /** Follow (or stop following) one thread's agents for the tree under its row. */
  | { kind: "tree"; threadId: string | undefined }
  /** Show one thread's transcript, requests and state in place (`ace thread show`). */
  | { kind: "thread-show"; threadId: string }
  | { kind: "place"; place: Place }
  | { kind: "doctor" }
  | { kind: "triage" }
  | { kind: "quit"; farewell: string; code: number };

export interface Step<S> {
  readonly state: S;
  readonly effects: readonly Effect[];
}

export const stay = <S>(state: S): Step<S> => ({ state, effects: [] });
export const step = <S>(state: S, ...effects: Effect[]): Step<S> => ({ state, effects });
