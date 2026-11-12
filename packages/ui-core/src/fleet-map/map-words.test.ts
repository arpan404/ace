import { expect, test } from "vitest";
import { fixLabel, networkOffQuestion, nodeFixes, nodeStateWords } from "./map-words.ts";

const problem = {
  what: "Mini isn't answering.",
  why: "It's asleep.",
  fixes: ["reconnect"] as const,
};

test("turning a network off asks first only while something reaches the machine", () => {
  expect(networkOffQuestion({ network: "Tailscale", where: "studio", dependents: [] })).toBe(
    undefined,
  );
  expect(
    networkOffQuestion({ network: "Tailscale", where: "studio", dependents: ["iPhone", "mini"] }),
  ).toEqual({
    title: "Turn off Tailscale on studio?",
    body: "iPhone and mini may disconnect until they can reach studio another way.",
    confirm: "Turn off",
  });
});

test("a node with a problem offers its fixes, else its offer, else nothing", () => {
  expect(nodeFixes({ problem, offer: "openAccount" })).toEqual(["reconnect"]);
  expect(nodeFixes({ problem: undefined, offer: "openAccount" })).toEqual(["openAccount"]);
  expect(nodeFixes({ problem: undefined, offer: undefined })).toEqual([]);
});

test("opening an account machine is a retry only once it failed", () => {
  expect(fixLabel({ problem: undefined }, "openAccount")).toBe("Open");
  expect(fixLabel({ problem: { ...problem, fixes: ["openAccount"] } }, "openAccount")).toBe(
    "Try again",
  );
});

test("a node's state words follow its tone, and a neutral one says its status", () => {
  expect(nodeStateWords({ tone: "bad", status: "Offline" })).toBe("Can't connect");
  expect(nodeStateWords({ tone: "warn", status: "Needs its code" })).toBe("Needs you");
  expect(nodeStateWords({ tone: "unknown", status: "Connecting" })).toBe("Connecting");
});
