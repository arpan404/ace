import { expect, test } from "vitest";
import { AppUpdateReply } from "./app-update.ts";

const base = { report: null, reportedAt: null };

test("a reply from an older daemon has no home data", () => {
  expect(AppUpdateReply.parse(base).homeData).toBeUndefined();
});

test("a reply keeps the home data it can read", () => {
  const homeData = { home: 3, daemon: 12, notify: null, spade: 4 };
  expect(AppUpdateReply.parse({ ...base, homeData }).homeData).toEqual(homeData);
});

test("home data this build can't read counts as absent rather than failing the reply", () => {
  const reply = AppUpdateReply.parse({ ...base, homeData: { home: "three" } });
  expect(reply.homeData).toBeUndefined();
  expect(reply.report).toBeNull();
});
