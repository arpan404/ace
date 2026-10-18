import type { FakeDaemon } from "@ace/fake-daemon";
import {
  DeviceId,
  ServerMessage,
  ThreadId,
  type ClientMessage,
  type CommandId,
} from "@ace/protocol";

/**
 * The texts waiting in a thread's daemon queue, read over the fixture's own wire as a client
 * would. A queued follow-up stays here, outside the transcript, until the root's turn ends.
 */
export async function queuedTexts(daemon: FakeDaemon, threadId: string): Promise<string[]> {
  const messages: ServerMessage[] = [];
  const connection = daemon.connect({
    send: (text) => {
      const parsed = ServerMessage.safeParse(JSON.parse(text));
      if (parsed.success) messages.push(parsed.data);
    },
    close() {},
  });
  const send = (message: ClientMessage) => connection.receive(JSON.stringify(message));
  try {
    send({
      type: "hello",
      deviceId: DeviceId.parse("ios-spike-queue-reader"),
      token: "ios-spike-token",
      protocolVersion: 1,
    });
    const texts: string[] = [];
    let after: CommandId | undefined;
    let revision: number | undefined;
    for (let page = 0; page < 64; page++) {
      const requestId = `queue-${page}`;
      send({
        type: "queue.get",
        requestId,
        threadId: ThreadId.parse(threadId),
        limit: 32,
        ...(after === undefined ? {} : { after, expectedRevision: revision }),
      });
      await Promise.resolve();
      const result = messages.find(
        (message) => message.type === "queue.result" && message.requestId === requestId,
      );
      if (result?.type !== "queue.result") throw new Error(`No queue page for ${threadId}`);
      for (const message of result.queue.messages)
        texts.push(message.input.map((part) => (part.type === "text" ? part.text : "")).join(""));
      if (result.queue.next === null) return texts;
      after = result.queue.next;
      revision = result.queue.revision;
    }
    throw new Error(`Queue for ${threadId} has more than 64 pages`);
  } finally {
    connection.close();
  }
}
