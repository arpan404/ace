import type { CommandPayload } from "@ace/protocol";

/**
 * What a key press asks the shell to do (ADR 0176 §9). The models are pure reducers that
 * return these; `app.ts` carries them out against the daemon and the terminal.
 */
export type Place = "projects" | "spade" | "market" | "settings" | "help";

export type Effect =
  /** Send one command through the client's outbox, with its own idempotency key. */
  | { kind: "command"; payload: CommandPayload; done: string }
  | { kind: "attach"; threadId: string }
  | { kind: "home" }
  | { kind: "requests" }
  /** Follow (or stop following) one thread's agents for the tree under its row. */
  | { kind: "tree"; threadId: string | undefined }
  | { kind: "new-thread" }
  | { kind: "place"; place: Place }
  | { kind: "doctor" }
  | { kind: "triage" }
  | { kind: "start" }
  /** Open $EDITOR on the composer's text; its result replaces the text. */
  | { kind: "editor"; text: string }
  /** Send what the composer holds to the attached thread (or start one). */
  | { kind: "send"; text: string; delivery: "queue" | "steer" }
  | { kind: "slash"; line: string }
  | { kind: "quit"; farewell: string; code: number };

export interface Step<S> {
  readonly state: S;
  readonly effects: readonly Effect[];
}

export const stay = <S>(state: S): Step<S> => ({ state, effects: [] });
export const step = <S>(state: S, ...effects: Effect[]): Step<S> => ({ state, effects });
