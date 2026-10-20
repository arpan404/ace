import type { ClientApi, StreamMessage } from "@ace/client";

/**
 * The in-memory client, plus binary stream messages the test hands in, with the requests and
 * one-way messages it sends recorded.
 */
export function streamingClient(client: ClientApi) {
  const listeners = new Set<(message: StreamMessage) => void>();
  const requests: unknown[] = [];
  const sent: unknown[] = [];
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
    stream(message: StreamMessage) {
      for (const listener of listeners) listener(message);
    },
  };
}
