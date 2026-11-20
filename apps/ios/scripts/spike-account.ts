/**
 * The ace account backend the phone's `--spike-account` launch signs in to, served on the spike
 * fixture's own port: the session, the account's machines, Forget, Sign out and Delete account, as
 * `packages/client/src/ace-account.ts` names them. It logs each Forget, Sign out and Delete it receives
 * (`GET /account/requests`) so a UI test can check that a cancelled question sent nothing and a
 * confirmed one sent exactly one request; `POST /account/reset` starts a test afresh.
 */

/** The session token the app's `--spike-account` launch presents. */
export const spikeAccountToken = "ios-spike-account-session";

/** The account's two machines, as 52-character host ids the phone accepts. */
export const spikeAccountMachineIds = {
  laptop: "L".repeat(52),
  studio: "S".repeat(52),
};

type Logged = { kind: "forget"; hostId: string } | { kind: "signOut" } | { kind: "delete" };
interface Machine {
  hostId: string;
  name: string;
  platform: string;
  lastSeenAt: number;
}

const account = { id: "acct_spike", email: "ada@example.com", name: "Ada Lovelace" };
const minute = 60_000;
const day = 86_400_000;

export class SpikeAccount {
  private machines: Machine[] = [];
  private signedIn = true;
  private log: Logged[] = [];

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
    this.reset();
  }

  /** The reply for an account path, or undefined for the rest of the fixture. */
  async handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path === "/account/requests") return Response.json({ requests: this.log });
    if (path === "/account/reset" && request.method === "POST") {
      this.reset();
      return Response.json({});
    }
    const owned =
      path === "/v1/account" ||
      path.startsWith("/v1/account/session") ||
      path.startsWith("/v1/machines");
    if (!owned) return;
    const authorized =
      this.signedIn && request.headers.get("authorization") === `Bearer ${spikeAccountToken}`;
    if (!authorized) return Response.json({}, { status: 401 });
    if (path === "/v1/account" && request.method === "DELETE") {
      this.log.push({ kind: "delete" });
      this.signedIn = false;
      return Response.json({ deleted: true });
    }
    if (path === "/v1/account/session") {
      if (request.method === "DELETE") {
        this.log.push({ kind: "signOut" });
        this.signedIn = false;
        return Response.json({});
      }
      return Response.json({ account, expiresAt: this.now() + day });
    }
    if (path === "/v1/machines" && request.method === "GET")
      return Response.json({ machines: this.machines });
    const forget = /^\/v1\/machines\/([A-Z2-7]{52})$/.exec(path)?.[1];
    if (forget && request.method === "DELETE") {
      this.log.push({ kind: "forget", hostId: forget });
      this.machines = this.machines.filter((machine) => machine.hostId !== forget);
      return Response.json({});
    }
    return Response.json({}, { status: 404 });
  }

  private reset() {
    const now = this.now();
    this.signedIn = true;
    this.log = [];
    this.machines = [
      {
        hostId: spikeAccountMachineIds.laptop,
        name: "arpan-mbp",
        platform: "darwin",
        lastSeenAt: now - 4 * minute,
      },
      {
        hostId: spikeAccountMachineIds.studio,
        name: "studio",
        platform: "linux",
        lastSeenAt: now - 3 * day,
      },
    ];
  }
}
