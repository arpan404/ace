import { afterEach, expect, test } from "vitest";
import { ProviderPayload, maxProviderPayloadBytes } from "@ace/provider-kit/payload";
import type { ProviderAdapter, Frame } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { AccountService, availability, ingestQuota, initialQuota, openRegistry } from "./index.ts";
import { cleanup, homes } from "./test-support.ts";
afterEach(cleanup);

test("encoded oversized maps and multibyte frames are refused before quota admission", () => {
  expect(
    () => new ProviderPayload('{"rate_limits":' + " ".repeat(maxProviderPayloadBytes) + "}"),
  ).toThrow("Provider payload exceeds byte limit");
  expect(
    () => new ProviderPayload(JSON.stringify("😀".repeat(maxProviderPayloadBytes / 3))),
  ).toThrow("Provider payload exceeds byte limit");
  expect(() => new ProviderPayload(new Uint8Array(maxProviderPayloadBytes + 1))).toThrow(
    "Provider payload exceeds byte limit",
  );
});

test("certified unknown data retains identity and cannot acquire an unbounded map after admission", () => {
  const payload = new ProviderPayload(
    '{"future":{"nested":[1,2]},"rate_limits":{"w0":{"utilization":10}}}',
  );
  const result = ingestQuota(
    { ...initialQuota(), auth: "logged_in" },
    {
      provider: "claude",
      payload,
      observedAt: 1,
      timeZone: "UTC",
    },
  );
  expect(result.raw).toBe(payload.data);
  expect(Reflect.set(Object(payload.data), "rate_limits", {})).toBe(false);
  expect(Reflect.set(Object(Reflect.get(Object(payload.data), "future")), "nested", [])).toBe(
    false,
  );
  expect(availability(result.state, 1)).toBe("available");
});

test.each([false, true])(
  "uncertified or mismatched adapter data never reaches the engine (mismatch %s)",
  async (mismatch) => {
    const request = await homes("claude");
    const registry = await openRegistry(request.to.homeDir + "/accounts.sqlite");
    await registry.register(request.from);
    let emit: ((frame: Frame) => void) | undefined;
    let observedExit = "";
    const received: Frame[] = [];
    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
    const { promise: faulted, resolve: fault } = Promise.withResolvers<void>();
    const adapter: ProviderAdapter = {
      provider: "claude",
      capabilities: () => {
        throw new Error("unused");
      },
      createTranslator: () => {
        throw new Error("unused");
      },
      openSession: async (ctx) => {
        emit = ctx.onFrame;
        return {
          nativeSessionId: "s",
          send: async () => {},
          interrupt: async () => {},
          resolve: async () => {},
          stopTask: async () => {},
          close: async () => {
            stop();
          },
        };
      },
    };
    const service = new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} });
    try {
      const opened = await service.openSession(
        adapter,
        {
          threadId: ThreadId.parse(request.nativeSessionId),
          cwd: request.from.homeDir,
          signal: new AbortController().signal,
          onFrame: (frame) => received.push(frame),
          onExit: (exit) => {
            observedExit = exit.message ?? "";
            fault();
          },
        },
        { instanceId: request.from.id, role: "worker", estimatedLoad: 1 },
      );
      if (!emit) throw new Error("Missing source");
      const payload = new ProviderPayload('{"auth":"logged_in"}');
      emit({
        seq: 1,
        t: 0,
        dir: "recv",
        channel: "stdio",
        data: { auth: "logged_in" },
        ...(mismatch ? { payload } : {}),
      });
      await Promise.all([stopped, faulted]);
      expect(received).toEqual([]);
      expect(observedExit).toBe("Provider frame has no valid bounded payload");
      expect(registry.summary(request.from.id, 1)?.quota.auth).toBe("unknown");
      await opened.session.close("shutdown");
    } finally {
      registry.close();
    }
  },
);

test("frames carry the account's billing mode, including a change reported mid-session", async () => {
  const request = await homes("claude");
  const registry = await openRegistry(request.to.homeDir + "/accounts.sqlite");
  await registry.register(request.from);
  let emit: ((frame: Frame) => void) | undefined;
  const received: Frame[] = [];
  const adapter: ProviderAdapter = {
    provider: "claude",
    capabilities: () => {
      throw new Error("unused");
    },
    createTranslator: () => {
      throw new Error("unused");
    },
    openSession: async (ctx) => {
      emit = ctx.onFrame;
      return {
        nativeSessionId: "s",
        send: async () => {},
        interrupt: async () => {},
        resolve: async () => {},
        stopTask: async () => {},
        close: async () => {},
      };
    },
  };
  const service = new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} });
  const frame = (data: Record<string, unknown>, seq: number): Frame => {
    const payload = new ProviderPayload(JSON.stringify(data));
    return { seq, t: 0, dir: "recv", channel: "stdio", data: payload.data, payload };
  };
  try {
    const opened = await service.openSession(
      adapter,
      {
        threadId: ThreadId.parse(request.nativeSessionId),
        cwd: request.from.homeDir,
        signal: new AbortController().signal,
        onFrame: (input) => received.push(input),
        onExit: () => {},
      },
      { instanceId: request.from.id, role: "worker", estimatedLoad: 1 },
    );
    if (!emit) throw new Error("Missing source");
    emit(frame({ type: "delta", text: "a" }, 1));
    emit(frame({ authDetail: "claude.ai" }, 2));
    emit(frame({ type: "delta", text: "b" }, 3));
    emit(frame({ billingMode: "api" }, 4));
    emit(frame({ type: "delta", text: "c" }, 5));
    expect(received.map((input) => input.usageAccount?.billingMode)).toEqual([
      "unknown",
      "subscription",
      "subscription",
      "api",
      "api",
    ]);
    await opened.session.close("shutdown");
  } finally {
    registry.close();
  }
});
