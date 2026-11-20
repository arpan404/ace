import { describe, expect, it } from "vitest";
import { socksReply } from "./socks5.ts";
import { failureMemoryMs, failureReply, TunnelFailures, tunnelFailure } from "./tunnel-failure.ts";

const coded = (code: string) => Object.assign(new Error(code), { code });

describe("why a tunnel stream didn't open", () => {
  it.each([
    ["tunnel_off", "off", socksReply.notAllowed],
    ["tunnel_forbidden", "forbidden", socksReply.notAllowed],
    ["tunnel_port_refused", "refused", socksReply.notAllowed],
    ["tunnel_limit", "limit", socksReply.generalFailure],
    ["offline", "offline", socksReply.networkUnreachable],
    ["timeout", "failed", socksReply.generalFailure],
  ])("%s is %s, answered %s", (code, failure, reply) => {
    expect(tunnelFailure(coded(code))).toBe(failure);
    expect(failureReply(tunnelFailure(coded(code)))).toBe(reply);
  });

  it("anything without a code just failed", () => {
    expect(tunnelFailure(new Error("boom"))).toBe("failed");
    expect(tunnelFailure("boom")).toBe("failed");
  });

  it("nothing listening is a refused connection", () => {
    expect(failureReply("closed")).toBe(socksReply.connectionRefused);
  });
});

describe("a machine's recent failures", () => {
  it("explain a failed load on that port for a while, then not", () => {
    let now = 1_000;
    const failures = new TunnelFailures(() => now);
    failures.record(3000, "closed");
    expect(failures.recent(3000)).toBe("closed");
    expect(failures.recent(4000)).toBeUndefined();
    now += failureMemoryMs + 1;
    expect(failures.recent(3000)).toBeUndefined();
  });

  it("are forgotten once the port serves", () => {
    const failures = new TunnelFailures(() => 0);
    failures.record(3000, "offline");
    failures.clear(3000);
    expect(failures.recent(3000)).toBeUndefined();
  });

  it("keep the latest failure per port", () => {
    const failures = new TunnelFailures(() => 0);
    failures.record(3000, "offline");
    failures.record(3000, "off");
    expect(failures.recent(3000)).toBe("off");
  });
});
