import { readSse } from "@ace/provider-kit/sse";
import { object } from "../data.ts";
import { setup } from "./session-harness.ts";

/** Hold a consumed second-pass response, acknowledging the first forcing SSE
 * event before its HTTP history request returns. No socket-order assumption. */
export async function recoveryBarrier(target: "status" | "history") {
  let histories = 0;
  let statuses = 0;
  let forcingType = "test.recovery";
  let historyAck: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const held = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  const observers = new Set<{ matches(data: unknown): boolean; resolve(): void }>();
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const history = path.endsWith("/message");
        const ack = history ? Promise.withResolvers<void>() : undefined;
        if (ack) historyAck = ack;
        const response = await fetch(input, init);
        const nthHistory = history ? ++histories : 0;
        const nthStatus = path === "/session/status" ? ++statuses : 0;
        if (ack) await ack.promise;
        if (
          (target === "history" && nthHistory === 2) ||
          (target === "status" && nthStatus === 2)
        ) {
          const snapshot = await response.text();
          held.resolve();
          await delivery.promise;
          return new Response(snapshot, { status: response.status, headers: response.headers });
        }
        return response;
      },
      stream: (url, options) =>
        readSse(url, {
          ...options,
          onEvent: (event) => {
            options.onEvent(event);
            const data: unknown = JSON.parse(event.data);
            if (object(object(data).payload).type === forcingType) historyAck?.resolve();
            for (const observer of observers)
              if (observer.matches(data)) {
                observers.delete(observer);
                observer.resolve();
              }
          },
        }),
    },
  });
  const observe = (matches: (data: unknown) => boolean) =>
    new Promise<void>((resolve) => {
      observers.add({ matches, resolve });
    });
  const recover = async (state: Record<string, unknown>) => {
    const onMessage = state.onMessage ?? {
      directory: "/one",
      payload: { type: "test.recovery", properties: { sessionID: h.session.nativeSessionId } },
    };
    forcingType = String(object(object(onMessage).payload).type);
    await h.control("/test/state", { ...state, onMessage });
    await h.control("/test/drop", {});
    await held.promise;
  };
  return { ...h, recover, observe, release: delivery.resolve };
}
