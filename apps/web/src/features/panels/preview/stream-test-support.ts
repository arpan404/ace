import type { ClientApi, StreamMessage } from "@ace/client";
import { MediaConnection } from "@ace/client/media";
import type { FakeDaemon } from "@ace/fake-daemon";
import type { PreviewMedia } from "./daemon-preview.ts";

/**
 * The client's media connection to a fake daemon's ace-media (X3: the only way a live view gets
 * pictures), opened for real through `MediaConnection`. The test can also hand decoded stream
 * messages straight to the view (`inject`), and every ack the view sends on it is recorded.
 */
export async function fakePreviewMedia(
  daemon: FakeDaemon,
  options: {
    acks?: unknown[];
    /** Only what the test injects reaches the view, not the fake daemon's own pictures. */
    injectedOnly?: boolean;
  } = {},
) {
  const acks = options.acks ?? [];
  const connection = new MediaConnection({
    connect: async () => ({
      type: "media.connect.result",
      requestId: "preview-media",
      result: daemon.media.grant(),
    }),
    socket: daemon.media.socket,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    now: () => performance.now(),
  });
  connection.start();
  await connection.settled();
  for (let turn = 0; turn < 20 && !connection.binding(); turn++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  const injected = new Set<(message: StreamMessage) => void>();
  const media: PreviewMedia = {
    binding: () => connection.binding(),
    settled: () => connection.settled(),
    watch: (listener) => connection.watch(listener),
    onStream: (listener) => {
      injected.add(listener);
      const stop = options.injectedOnly ? () => {} : connection.onStream(listener);
      return () => {
        injected.delete(listener);
        stop();
      };
    },
    ack: (message) => {
      acks.push(message);
      return connection.ack(message);
    },
  };
  return {
    media,
    connection,
    acks,
    /** A stream message as if it came on the media connection. */
    inject(message: StreamMessage) {
      for (const listener of injected) listener(message);
    },
  };
}

/**
 * The in-memory client, plus stream messages the test hands in on its media connection, with
 * the requests and one-way messages it sends recorded (acks on the media connection included).
 */
export function streamingClient(
  client: ClientApi,
  media?: Awaited<ReturnType<typeof fakePreviewMedia>>,
) {
  const listeners = new Set<(message: StreamMessage) => void>();
  const requests: unknown[] = [];
  const sent: unknown[] = media?.acks ?? [];
  const api = new Proxy(client, {
    get(target, key) {
      if (key === "onStream")
        return (listener: (message: StreamMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
      if (key === "request")
        return (input: Parameters<ClientApi["request"]>[0], options?: object) => {
          requests.push(input);
          return target.request(input, options);
        };
      if (key === "send")
        return (message: Parameters<ClientApi["send"]>[0]) => {
          sent.push(message);
          target.send(message);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    api,
    requests,
    sent,
    ...(media ? { media: media.media } : {}),
    /** A stream message: on the media connection when there is one, else the main socket. */
    stream(message: StreamMessage) {
      if (media) return media.inject(message);
      for (const listener of listeners) listener(message);
    },
  };
}
