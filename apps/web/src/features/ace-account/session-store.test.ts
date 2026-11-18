import { expect, test } from "vitest";
import { fakeAccountBackend, fakeOrigin } from "@/boot/fake-account.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { aceAccountClient } from "@ace/client/ace-account";
import { aceAccountStore } from "./session-store.ts";

/** A window's account store: signed in with the fake account, or with nothing saved. */
function store(signedIn: boolean) {
  const storage = memoryKeyValue();
  const backend = fakeAccountBackend(storage, Date.now);
  if (!signedIn) storage.removeItem(`ace.account.session:${fakeOrigin}`);
  return aceAccountStore(backend);
}

/** The first caller leaves before its check ends (a remount), the second stays. */
async function restoreAcrossRemount(account: ReturnType<typeof aceAccountStore>) {
  const first = new AbortController();
  const pending = account.restore(first.signal);
  first.abort();
  await account.restore(new AbortController().signal);
  await pending;
}

test("a restore cut short by a remount still ends, with no session saved", async () => {
  const account = store(false);
  await restoreAcrossRemount(account);
  expect(account.get()).toMatchObject({ restoring: false, session: null });
});

test("a restore cut short by a remount still ends, signed in", async () => {
  const account = store(true);
  await restoreAcrossRemount(account);
  expect(account.get().restoring).toBe(false);
  expect(account.get().session?.account.email).toBe("arpan@example.com");
});

/** The app's saved copy, refusing every write with `message`. */
const failing = (message: string) => ({
  read: async () => null,
  write: async () => {
    throw new Error(message);
  },
});

test("a sign-in the app can't save stays signed in and says why it won't last", async () => {
  const storage = memoryKeyValue();
  const backend = fakeAccountBackend(storage, Date.now);
  const session = store(true).get().session;
  if (!session) throw new Error("the fake account has a session");

  const noKeyring = aceAccountStore({
    ...backend,
    secure: failing(
      "Error invoking remote method 'account.write': Error: Secure account storage is unavailable",
    ),
  });
  await noKeyring.signedIn(session);
  expect(noKeyring.get().session?.account.email).toBe("arpan@example.com");
  expect(noKeyring.get().error).toContain("Install GNOME Keyring or KWallet");

  const other = aceAccountStore({ ...backend, secure: failing("disk full") });
  await other.signedIn(session);
  expect(other.get().session).not.toBeNull();
  expect(other.get().error).toBe(
    "Signed in until ace closes: ace couldn't save your sign-in on this computer.",
  );
});

test("signing in again while signed in replaces the session once the browser finishes", async () => {
  const storage = memoryKeyValue();
  const backend = fakeAccountBackend(storage, Date.now);
  const before = store(true);
  await before.restore(new AbortController().signal);
  const old = before.get().session;
  if (!old) throw new Error("the fake account has a session");
  const id = "i".repeat(43);
  const fresh = "g".repeat(43);
  const client = aceAccountClient({
    origin: fakeOrigin,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/account/login" && init?.method === "POST")
        return Response.json({
          id,
          secret: "s".repeat(43),
          loginUrl: `${fakeOrigin}/v1/account/login?id=${id}`,
          expiresAt: Date.now() + 600_000,
        });
      if (path === `/v1/account/login/${id}`)
        return Response.json({ status: "complete", session: { ...old, token: fresh } });
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
  });
  storage.setItem(`ace.account.session:${fakeOrigin}`, JSON.stringify(old));
  const account = aceAccountStore({ ...backend, client });
  const opened: string[] = [];

  const signed = await account.signInAgain(async (address) => {
    opened.push(await address);
  });

  expect(signed).toBe(true);
  expect(opened).toEqual([`${fakeOrigin}/v1/account/login?id=${id}`]);
  expect(account.get().session?.token).toBe(fresh);
});
