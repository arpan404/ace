import { expect, it, vi } from "vitest";
import { WebSocketGate } from "./socket-gate.ts";
import { z } from "zod";
const Request = z.object({ id: z.string(), url: z.string() });

it("asks for every handshake so a revoked origin does not reuse an earlier approval", () => {
  const gate = new WebSocketGate();
  const decisions: boolean[] = [];
  let allowed = true;
  const emit = (method: string, raw: unknown) => {
    expect(method).toBe("ace.webSocketRequested");
    const request = Request.parse(raw);
    expect(request.url).toBe("wss://app.example/socket");
    gate.command("ace.webSocketDecision", { id: request.id, allowed });
  };
  gate.request("wss://app.example/socket", emit, (value) => decisions.push(value));
  allowed = false;
  gate.request("wss://app.example/socket", emit, (value) => decisions.push(value));
  expect(decisions).toEqual([true, false]);
  gate.close();
});
it("denies invalid URLs, requests over capacity, lost views and unanswered requests", () => {
  vi.useFakeTimers();
  try {
    const gate = new WebSocketGate();
    const decisions: boolean[] = [];
    const reply = (allowed: boolean) => decisions.push(allowed);
    for (const url of ["https://app.example", "ws://user:pass@app.example", "invalid"])
      gate.request(url, () => {}, reply);
    for (let count = 0; count < 33; count++)
      gate.request("wss://app.example/socket", () => {}, reply);
    expect(decisions).toEqual([false, false, false, false]);
    vi.advanceTimersByTime(10_000);
    expect(decisions).toHaveLength(36);
    expect(decisions.every((value) => value === false)).toBe(true);
    gate.request("wss://app.example/socket", () => {}, reply);
    gate.close();
    expect(decisions).toHaveLength(37);
  } finally {
    vi.useRealTimers();
  }
});
