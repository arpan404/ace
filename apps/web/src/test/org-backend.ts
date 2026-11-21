import { aceAccountClient } from "@ace/client/ace-account";
import { aceOrgClient } from "@ace/client/ace-org";
import { fakeHostIds, fakeOrigin, fakePerson } from "@/boot/fake-account.ts";
import { fakeOrgRoutes, fakeOrgs } from "@/boot/fake-orgs.ts";
import { memoryKeyValue } from "./harness.tsx";

/**
 * A signed-in window's account backend with organizations (ADR 0206), at the fetch edge: the
 * fake person owns Acme Robotics and is a member of Night Shift Labs. Every call is recorded as
 * `METHOD /path?query` with its body; `hold` keeps answers to matching calls until released.
 */
export function orgBackend(options: { space?: string } = {}) {
  const storage = memoryKeyValue();
  const now = Date.now;
  const session = { token: "f".repeat(43), expiresAt: now() + 86_400_000, account: fakePerson };
  storage.setItem(`ace.account.session:${fakeOrigin}`, JSON.stringify(session));
  if (options.space) storage.setItem(`ace.space:${fakeOrigin}:${fakePerson.id}`, options.space);
  const personal = [
    { hostId: fakeHostIds.studio, name: "Studio", platform: "darwin", lastSeenAt: now() - 60_000 },
    { hostId: fakeHostIds.laptop, name: "Travel laptop", platform: "linux", lastSeenAt: now() },
  ];
  const routes = fakeOrgRoutes({ person: fakePerson, now, personal: () => personal, world: "org" });
  const calls: { call: string; body: unknown }[] = [];
  const held: { match: (call: string) => boolean; gate: Promise<void> }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push({ call, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const hold of held) if (hold.match(call)) await hold.gate;
    if (url.pathname === "/v1/account/session")
      return Response.json({ account: fakePerson, expiresAt: session.expiresAt });
    return (await routes(url, init)) ?? Response.json({ error: "unavailable" }, { status: 503 });
  };
  return {
    storage,
    calls,
    /** Holds answers to calls `match` picks until the returned function runs. */
    hold(match: (call: string) => boolean): () => void {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ match, gate: promise });
      return resolve;
    },
    backend: () => ({
      origin: fakeOrigin,
      client: aceAccountClient({ origin: fakeOrigin, fetch }),
      orgs: aceOrgClient({ origin: fakeOrigin, fetch }),
      storage,
    }),
    orgs: fakeOrgs,
  };
}
