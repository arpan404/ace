import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { DeepLink } from "../shared/contract.ts";
import { deliverAfterLoads } from "./deep-link-delivery.ts";

test("a link received during a second page load is delivered once after that reload", () => {
  const page = new EventEmitter();
  const pending: DeepLink[] = [{ kind: "new-thread" }];
  const opened: DeepLink[] = [];
  deliverAfterLoads(page, pending, (link) => opened.push(link));
  page.emit("did-finish-load");
  pending.push({ kind: "thread", threadId: "saved-thread" });
  page.emit("did-finish-load");
  page.emit("did-finish-load");
  expect(opened).toEqual([{ kind: "new-thread" }, { kind: "thread", threadId: "saved-thread" }]);
});
