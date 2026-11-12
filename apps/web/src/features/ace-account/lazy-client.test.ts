import { aceAccountClient } from "@ace/client/ace-account";
import { AceAccountError } from "@ace/client/ace-account-error";
import { expect, test } from "vitest";
import { memoryKeyValue } from "@/test/harness.tsx";
import { lazyAceAccountClient } from "./lazy-client.ts";
import { aceAccountStore } from "./session-store.ts";

const origin = "https://account.example.com";
const person = { id: "user_fake", email: "arpan@example.com", name: "Arpan Bhandari" };
const token = "f".repeat(43);

/** The account backend, which knows the session. */
const backend: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === "/v1/account/session")
    return Response.json({ account: person, expiresAt: 4_000_000_000_000 });
  return Response.json({ error: "unavailable" }, { status: 503 });
};

/** Loads of the client's code, each failing or arriving when the test says. */
function loads() {
  const pending: PromiseWithResolvers<{ aceAccountClient: typeof aceAccountClient }>[] = [];
  return {
    pending,
    load: () => {
      const next = Promise.withResolvers<{ aceAccountClient: typeof aceAccountClient }>();
      pending.push(next);
      return next.promise;
    },
    arrive: (index: number) => pending[index]?.resolve({ aceAccountClient }),
    fail: (index: number) => pending[index]?.reject(new TypeError("Failed to fetch module")),
  };
}

function signedInStore(client: ReturnType<typeof lazyAceAccountClient>) {
  const storage = memoryKeyValue();
  storage.setItem(
    `ace.account.session:${origin}`,
    JSON.stringify({ token, expiresAt: 4_000_000_000_000, account: person }),
  );
  return aceAccountStore({ origin, client, storage });
}

test("a saved session stays restoring while the account code loads slowly, then is checked", async () => {
  const code = loads();
  const store = signedInStore(lazyAceAccountClient({ origin, fetch: backend }, code.load));
  const restored = store.restore(new AbortController().signal);
  await Promise.resolve();
  expect(store.get()).toMatchObject({ restoring: true, session: { token } });

  code.arrive(0);
  await restored;
  expect(store.get()).toMatchObject({ restoring: false, error: "", session: { account: person } });
});

test("a failed load of the account code ends the restore with an error, and the next call loads again", async () => {
  const code = loads();
  const client = lazyAceAccountClient({ origin, fetch: backend }, code.load);
  const store = signedInStore(client);
  const restored = store.restore(new AbortController().signal);
  code.fail(0);
  await restored;
  // Not signed out: the backend never refused the session, the code just didn't arrive.
  expect(store.get()).toMatchObject({
    restoring: false,
    error: "Couldn't verify your account. Try again.",
    session: { token },
  });

  const again = client.session(token, new AbortController().signal);
  await Promise.resolve();
  expect(code.pending).toHaveLength(2);
  code.arrive(1);
  expect(await again).toMatchObject({ account: person });
});

test("the backend's refusal still reads as the account error once the code has loaded", async () => {
  const code = loads();
  const client = lazyAceAccountClient(
    { origin, fetch: async () => new Response(null, { status: 401 }) },
    code.load,
  );
  const call = client.session(token, new AbortController().signal);
  code.arrive(0);
  await expect(call).rejects.toBeInstanceOf(AceAccountError);
  await expect(call).rejects.toMatchObject({ status: 401 });
});
