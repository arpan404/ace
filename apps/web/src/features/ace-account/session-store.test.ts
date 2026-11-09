import { expect, test } from "vitest";
import { fakeAccountBackend, fakeOrigin } from "@/boot/fake-account.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
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
