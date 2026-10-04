import { describe, expect, it } from "vitest";
import { claimAfterLease, claimHolds } from "./input-grant.ts";

const claim = { owner: "web", since: 4 };

describe("a renderer's claim on a page", () => {
  it("holds only while the lease is human and its connection's", () => {
    expect(claimHolds(claim, { generation: 5, controller: "human", owner: "web" })).toBe(true);
    expect(claimHolds(claim, { generation: 5, controller: "human", owner: "phone" })).toBe(false);
    expect(claimHolds(claim, { generation: 5, controller: "agent" })).toBe(false);
    expect(claimHolds(undefined, { generation: 5, controller: "human", owner: "web" })).toBe(false);
  });

  it("waits for its own lease when it arrives before it", () => {
    expect(claimAfterLease(claim, { generation: 4, controller: "agent" })).toEqual(claim);
    expect(claimAfterLease(claim, { generation: 5, controller: "human", owner: "web" })).toEqual(
      claim,
    );
  });

  it("is revoked by any newer lease that isn't its connection's", () => {
    expect(claimAfterLease(claim, { generation: 5, controller: "agent" })).toBeUndefined();
    expect(
      claimAfterLease(claim, { generation: 5, controller: "human", owner: "phone" }),
    ).toBeUndefined();
  });
});
