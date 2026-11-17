import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { Store } from "../store.ts";
import { HeldMessages } from "./held-messages.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function held() {
  const home = mkdtempSync(join(tmpdir(), "ace-held-messages-"));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  cleanup.push(() => store.close());
  return new HeldMessages(store);
}
const message = (requestId: string, text = "x") =>
  ({
    op: "message",
    threadId: ThreadId.parse("child"),
    requestId,
    text,
    delivery: "queue",
  }) as const;
const bytesOf = (requestId: string, text = "x") =>
  Buffer.byteLength(JSON.stringify(message(requestId, text)));

test("each device holds at most its count and its bytes, and copies of held messages always fit", () => {
  const messages = held();
  const limits = {
    perDevice: { count: 2, bytes: 10_000 },
    total: { count: 100, bytes: 100_000 },
  };
  expect(messages.hold("a1", "laptop", message("a1"), limits)).toBe("held");
  expect(messages.hold("a2", "laptop", message("a2"), limits)).toBe("held");
  expect(messages.hold("a3", "laptop", message("a3"), limits)).toBe("full");
  expect(messages.hold("a1", "laptop", message("a1"), limits)).toBe("held");
  // Another device has its own budget; by bytes, a large message fills it before the count.
  const roomy = { ...limits, perDevice: { count: 10, bytes: 10_000 } };
  const big = "y".repeat(6_000);
  expect(messages.hold("b1", "phone", message("b1", big), roomy)).toBe("held");
  expect(messages.hold("b2", "phone", message("b2", big), roomy)).toBe("full");
  expect(messages.hold("b3", "phone", message("b3"), roomy)).toBe("held");
  expect(messages.oldest().map((held) => held.key)).toEqual(["a1", "a2", "b1", "b3"]);
});

test("the machine as a whole holds at most its count and its bytes, across devices", () => {
  const messages = held();
  const total = bytesOf("d0") * 3;
  const limits = { perDevice: { count: 10, bytes: 100_000 }, total: { count: 10, bytes: total } };
  for (const device of ["d0", "d1", "d2"])
    expect(messages.hold(device, device, message(device), limits)).toBe("held");
  expect(messages.hold("d3", "d3", message("d3"), limits)).toBe("full");
  const counted = { perDevice: { count: 10, bytes: 100_000 }, total: { count: 3, bytes: 1e9 } };
  expect(messages.hold("d4", "d4", message("d4"), counted)).toBe("full");
});
