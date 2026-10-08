/** Authored saved transcript content. These are fixture conversations, never live sessions. */
export const savedTranscripts = {
  "relay-claude": [
    {
      at: 1791400200000,
      role: "user",
      text: "Check how reconnect replay orders the last saved event and the first live event.",
    },
    {
      at: 1791400260000,
      role: "assistant",
      text: "The replay cursor advances only after the event is stored. Live events arriving during replay wait behind that cursor, so reconnects preserve transcript order.",
    },
  ],
  "relay-codex": [
    {
      at: 1791400200000,
      role: "user",
      text: "Keep reconnect retry delays bounded when the connection repeatedly fails.",
    },
    {
      at: 1791400260000,
      role: "assistant",
      text: "Retry delays now cap at 30 seconds. A successful connection resets the backoff, and cancellation clears the pending retry.",
    },
  ],
  "relay-opencode": [
    {
      at: 1791400200000,
      role: "user",
      text: "Audit how the background runner reports completion.",
    },
    {
      at: 1791400260000,
      role: "assistant",
      text: "The thread remains working until its background shell exits. Waiting for a person also keeps the thread open; the root reply alone cannot mark it done.",
    },
  ],
} satisfies Record<string, { role: "user" | "assistant"; text: string; at: number }[]>;
