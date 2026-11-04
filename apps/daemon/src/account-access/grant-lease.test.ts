import { describe, expect, it } from "vitest";
import { GRANT_GRACE_MS, grantLeaseState, grantRefreshOutcome } from "./grant-lease.ts";

describe("an account socket's grant", () => {
  it.each([
    { case: "well before expiry", now: 1_000, state: "held" },
    { case: "at expiry, inside the grace", now: 10_000, state: "held" },
    { case: "just before the grace ends", now: 10_000 + GRANT_GRACE_MS - 1, state: "held" },
    { case: "when the grace ends", now: 10_000 + GRANT_GRACE_MS, state: "expired" },
    { case: "long after", now: 10_000_000, state: "expired" },
  ])("is $state $case", ({ now, state }) => {
    expect(grantLeaseState(10_000, now)).toBe(state);
  });

  it("uses the grace it is given", () => {
    expect(grantLeaseState(10_000, 10_000, 0)).toBe("expired");
    expect(grantLeaseState(10_000, 10_999, 1_000)).toBe("held");
  });
});

const admitted = (account: string, expiresAt: number) =>
  ({ admitted: true, account, expiresAt }) as const;

describe("refreshing an account socket's grant", () => {
  it.each([
    {
      case: "a fresh grant for the same account moves the expiry on",
      admission: admitted("user_a", 50_000),
      outcome: { kind: "extended", expiresAt: 50_000 },
    },
    {
      case: "a grant that ends sooner never shortens the one held",
      admission: admitted("user_a", 15_000),
      outcome: { kind: "extended", expiresAt: 20_000 },
    },
    {
      case: "a grant for another account is refused",
      admission: admitted("user_b", 50_000),
      outcome: { kind: "refused", code: "unauthorized" },
    },
    {
      case: "a grant the machine refuses is refused with its reason",
      admission: {
        admitted: false,
        code: "unauthorized",
        message: "Valid hello required",
      } as const,
      outcome: { kind: "refused", code: "unauthorized", message: "Valid hello required" },
    },
    {
      case: "a device that no longer holds the machine code is refused",
      admission: {
        admitted: false,
        code: "machine_code_required",
        message: "Enter this machine's code.",
      } as const,
      outcome: { kind: "refused", code: "machine_code_required" },
    },
  ])("$case", ({ admission, outcome }) => {
    expect(grantRefreshOutcome({ admission, account: "user_a", heldUntil: 20_000 })).toMatchObject(
      outcome,
    );
  });
});
