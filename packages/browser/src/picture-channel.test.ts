import { describe, expect, it } from "vitest";
import { PictureChannel, pictureBacklogBytes, type CapturedPicture } from "./picture-channel.ts";
import { decodeStreamMessage, StreamAssembler, type StreamMessage } from "./stream.ts";
import { streamKinds } from "./stream-envelope.ts";

const session = "session-1";

function picture(sequence: number, size = 1000): CapturedPicture {
  return {
    sequence,
    timestamp: sequence,
    width: 800,
    height: 600,
    scale: 2,
    rotation: 0,
    codec: "jpeg",
    key: true,
    codecNamed: false,
    streamId: session,
    bytes: new Uint8Array(size).fill(sequence % 256),
  };
}

function setup(options: { buffered?: () => number } = {}) {
  const pieces: Uint8Array[] = [];
  const failures: unknown[] = [];
  const timers: (() => void)[] = [];
  const channel = new PictureChannel(streamKinds.screenFrame, {
    transport: {
      bufferedBytes: options.buffered ?? (() => 0),
      write: async (piece) => {
        pieces.push(piece);
      },
    },
    now: () => 0,
    after: (_ms, run) => {
      timers.push(run);
      return () => {};
    },
    failed: (error) => failures.push(error),
  });
  const messages = (): StreamMessage[] => {
    const assembler = new StreamAssembler();
    return pieces.flatMap((piece) => {
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      return message ? [message] : [];
    });
  };
  return {
    channel,
    messages,
    failures,
    timers,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("one connection's pictures", () => {
  it("a screenshot and live pictures larger than a piece arrive whole and in order", async () => {
    const view = setup();
    const live = view.channel.open(session, { keyframe: () => {}, guard: () => {} });
    live.push(picture(1, 150_000));
    const still = view.channel.still(session, picture(1, 150_000), () => {});
    live.push(picture(2, 150_000));
    await still;
    await settle();
    expect(
      view
        .messages()
        .map((message) =>
          message.kind === "screen.frame"
            ? [message.sourceId, message.frame.sequence, message.frame.still ?? false]
            : [],
        ),
    ).toEqual([
      [session, 1, false],
      [session, 1, true],
      [session, 2, false],
    ]);
  });

  it("refuses a screenshot while the connection is backed up", async () => {
    const view = setup({ buffered: () => pictureBacklogBytes + 1 });
    await expect(view.channel.still(session, picture(1), () => {})).rejects.toThrow(/congested/);
    expect(view.messages()).toEqual([]);
  });

  it("a live view waits out a backed-up transport and sends the newest picture after", async () => {
    let buffered = pictureBacklogBytes + 1;
    const view = setup({ buffered: () => buffered });
    const live = view.channel.open(session, { keyframe: () => {}, guard: () => {} });
    live.push(picture(1));
    live.push(picture(2));
    expect(view.messages()).toEqual([]);
    buffered = 0;
    for (const retry of view.timers.splice(0)) retry();
    await settle();
    expect(
      view.messages().map((message) => message.kind === "screen.frame" && message.frame.sequence),
    ).toEqual([2]);
  });

  it("a view whose access was revoked ends the connection's pictures", async () => {
    const view = setup();
    const live = view.channel.open(session, {
      keyframe: () => {},
      guard: () => {
        throw new Error("revoked");
      },
    });
    live.push(picture(1));
    await settle();
    expect(view.messages()).toEqual([]);
    expect(view.failures).toHaveLength(1);
  });

  it("an ack opens a JPEG viewer's window for the newest picture only", async () => {
    const view = setup();
    const live = view.channel.open(session, { keyframe: () => {}, guard: () => {} });
    for (let sequence = 1; sequence <= 10; sequence++) {
      live.push(picture(sequence));
      await settle();
    }
    const sent = () =>
      view.messages().map((message) => message.kind === "screen.frame" && message.frame.sequence);
    expect(sent()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    view.channel.ack(session, session, 8);
    await settle();
    expect(sent().slice(8)).toEqual([10]);
  });
});
