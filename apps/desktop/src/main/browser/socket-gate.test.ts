import { describe, expect, it } from "vitest";
import { WebSocketGate } from "./socket-gate.ts";

function pausedThen(gate: WebSocketGate, url: string, decision: string, requestId = url) {
  gate.event("Fetch.requestPaused", { requestId, request: { url } });
  gate.command(decision, { requestId });
}

describe("WebSockets in an embedded view", () => {
  it("are refused until the daemon has approved their origin", () => {
    const gate = new WebSocketGate();
    expect(gate.allows("wss://app.example.com/socket")).toBe(false);
  });

  it("may connect to an origin the daemon let through Fetch", () => {
    const gate = new WebSocketGate();
    pausedThen(gate, "https://app.example.com/index.html", "Fetch.continueRequest");
    expect(gate.allows("wss://app.example.com/live")).toBe(true);
    pausedThen(gate, "http://localhost:5173/", "Fetch.continueRequest");
    expect(gate.allows("ws://localhost:5173/@vite/client")).toBe(true);
  });

  it("stay closed for an origin the daemon refused", () => {
    const gate = new WebSocketGate();
    pausedThen(gate, "https://tracker.example/pixel", "Fetch.failRequest");
    expect(gate.allows("wss://tracker.example/")).toBe(false);
  });

  it("never cross schemes, hosts or ports from an approval", () => {
    const gate = new WebSocketGate();
    pausedThen(gate, "https://app.example.com/", "Fetch.continueRequest");
    expect(gate.allows("ws://app.example.com/")).toBe(false);
    expect(gate.allows("wss://other.example.com/")).toBe(false);
    expect(gate.allows("wss://app.example.com:8443/")).toBe(false);
  });

  it("ignore a continue for a request the view never paused", () => {
    const gate = new WebSocketGate();
    gate.command("Fetch.continueRequest", { requestId: "unknown" });
    expect(gate.allows("wss://app.example.com/")).toBe(false);
  });
});
