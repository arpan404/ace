import { afterEach, beforeEach, vi } from "vitest";

/** The relay host id the tests' local daemon homes name. */
export const relayHostId = "H".repeat(52);
/** The enrollment ticket the fake account backend gives for it (ADR 0190). */
export const ticket = "t".repeat(43);
const issued = new Map<string, string>();
/** The tests' usual session gets `ticket`; any other its own, so a fake daemon can tell them apart. */
const ticketFor = (session: string) => {
  const given = session === "s".repeat(43) ? ticket : `T${session.slice(1)}`;
  issued.set(given, session);
  return given;
};
/** The session the fake backend gave `given` for. */
export const sessionOfTicket = (given: string) => issued.get(given);

/**
 * The account backend at `origin`, faked at the fetch boundary: it answers an enrollment request
 * for `relayHostId` with `ticket` and records who asked; every other request goes on as before.
 * The tests' daemons are real local servers.
 */
export function fakeEnrollments(origin: string) {
  const asked: { token: string | undefined; hostId: unknown }[] = [];
  const real = globalThis.fetch;
  beforeEach(() => {
    asked.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== `${origin}/v1/machine-enrollments`) return real(input, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as { hostId?: unknown };
      const headers = new Headers(init?.headers);
      asked.push({
        token: headers.get("authorization")?.replace(/^Bearer /, ""),
        hostId: body.hostId,
      });
      const session = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return Response.json(
        body.hostId === relayHostId
          ? { ticket: ticketFor(session), expiresAt: Date.now() + 600_000 }
          : { error: "other_machine" },
        { status: body.hostId === relayHostId ? 201 : 403 },
      );
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  return asked;
}
