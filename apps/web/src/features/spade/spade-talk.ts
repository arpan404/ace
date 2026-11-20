/*
 * A spoken conversation with a bot, hands free (ADR 0134, amended): listen, notice the end of
 * what the person said, send it, speak the reply, listen again. The person talking over the
 * reply stops it and is heard. A while with nothing said ends the conversation. This is the
 * rules alone, as a pure step: the hook around it owns the microphone, the recorder and the
 * speaker, and carries out the effects it answers.
 */

export type TalkState =
  | { kind: "off" }
  /** Waiting for the person to talk, since `since`. */
  | { kind: "listening"; since: number }
  /** The person is talking; the recording runs. */
  | { kind: "hearing" }
  /** The recording is turning into words. */
  | { kind: "transcribing" }
  /** Sent; the bot is working on its answer. */
  | { kind: "thinking" }
  /** The bot's answer is being read aloud. */
  | { kind: "speaking" };

export type TalkEvent =
  | { kind: "start"; at: number }
  | { kind: "end" }
  | { kind: "speech-start" }
  | { kind: "speech-end" }
  /** What the recording said; empty when nothing could be made out. */
  | { kind: "words"; words: string; at: number }
  | { kind: "failed"; at: number }
  /** Speech of the reply began. */
  | { kind: "speaking" }
  /** The reply is over and nothing more is being said: the person's turn again. */
  | { kind: "turn-over"; at: number }
  | { kind: "tick"; at: number };

export type TalkEffect =
  | "record"
  | "transcribe"
  | "discard-recording"
  | "send"
  | "stop-speaking"
  | "ended-quietly";

export interface TalkStep {
  state: TalkState;
  effects: TalkEffect[];
  /** The words to send, with `send`. */
  words?: string;
}

/** Nothing said for this long while listening ends the conversation. */
export const talkIdleMs = 30_000;

export const talkOff: TalkState = { kind: "off" };

const stay = (state: TalkState): TalkStep => ({ state, effects: [] });

export function talkStep(state: TalkState, event: TalkEvent, idleMs = talkIdleMs): TalkStep {
  if (event.kind === "end")
    return {
      state: talkOff,
      effects:
        state.kind === "hearing"
          ? ["discard-recording"]
          : state.kind === "speaking"
            ? ["stop-speaking"]
            : [],
    };
  switch (state.kind) {
    case "off":
      return event.kind === "start" ? stay({ kind: "listening", since: event.at }) : stay(state);
    case "listening":
      if (event.kind === "speech-start") return { state: { kind: "hearing" }, effects: ["record"] };
      if (event.kind === "tick" && event.at - state.since >= idleMs)
        return { state: talkOff, effects: ["ended-quietly"] };
      return stay(state);
    case "hearing":
      if (event.kind === "speech-end")
        return { state: { kind: "transcribing" }, effects: ["transcribe"] };
      return stay(state);
    case "transcribing":
      if (event.kind === "words")
        return event.words.trim()
          ? { state: { kind: "thinking" }, effects: ["send"], words: event.words.trim() }
          : stay({ kind: "listening", since: event.at });
      if (event.kind === "failed") return stay({ kind: "listening", since: event.at });
      return stay(state);
    case "thinking":
      if (event.kind === "speaking") return stay({ kind: "speaking" });
      if (event.kind === "turn-over") return stay({ kind: "listening", since: event.at });
      // The person talks before the answer comes: they are heard, and the answer still comes.
      if (event.kind === "speech-start") return { state: { kind: "hearing" }, effects: ["record"] };
      return stay(state);
    case "speaking":
      // Barge-in: talking over the reply stops it at once and the person is heard.
      if (event.kind === "speech-start")
        return { state: { kind: "hearing" }, effects: ["stop-speaking", "record"] };
      if (event.kind === "turn-over") return stay({ kind: "listening", since: event.at });
      return stay(state);
  }
}

/** The one quiet line above the composer, in words. */
export function talkLine(state: TalkState, name: string): string | undefined {
  switch (state.kind) {
    case "off":
      return undefined;
    case "listening":
      return "Listening";
    case "hearing":
      return "Hearing you";
    case "transcribing":
      return "Turning it into words";
    case "thinking":
      return `${name} is thinking`;
    case "speaking":
      return `${name} is speaking`;
  }
}
