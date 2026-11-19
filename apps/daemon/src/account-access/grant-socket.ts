import type { ServerMessage } from "@ace/protocol";
import { grantLeaseState, grantRefreshOutcome } from "./grant-lease.ts";
import type { MachineAccount } from "./machine-account.ts";

type RefreshResult = Extract<ServerMessage, { type: "account.grant.refresh.result" }>["result"];

/**
 * One account socket's grant (ADR 0111, ADR 0114): when it runs out, and the socket's
 * `account.grant.refresh`, which checks a new grant through `admitDevice` as a hello's grant is
 * checked and moves the expiry on. The clock is injected.
 */
export function accountGrantSocket(input: {
  expiresAt: number;
  /** The account the socket was admitted for. */
  account: string;
  deviceId: string;
  machine: MachineAccount | undefined;
  now: () => number;
}) {
  let expiresAt = input.expiresAt;
  const ttlMs = () => Math.max(0, expiresAt - input.now());
  return {
    /** How long the socket's grant has left, for the welcome and each refresh's answer. */
    ttlMs,
    /** The grant ran out and its grace passed: the socket must close. */
    expired: () => grantLeaseState(expiresAt, input.now()) === "expired",
    async refresh(grant: string): Promise<RefreshResult> {
      if (!input.machine)
        return { ok: false, code: "unauthorized", message: "ace account is unavailable." };
      const admission = await input.machine.admitDevice({ grant, deviceId: input.deviceId });
      const outcome = grantRefreshOutcome({
        admission,
        account: input.account,
        heldUntil: expiresAt,
      });
      if (outcome.kind === "refused")
        return { ok: false, code: outcome.code, message: outcome.message };
      expiresAt = outcome.expiresAt;
      return { ok: true, grantTtlMs: ttlMs() };
    },
  };
}
export type AccountGrantSocket = ReturnType<typeof accountGrantSocket>;
