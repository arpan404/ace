import { AceLogin, AceLoginStatus, type AceAccountGrant } from "@ace/protocol/ace-account";
import type { WorkosUser, fakeWorkos } from "./fake-workos.ts";
import { allowedOrigin, publicUrl } from "./worker.ts";

let codes = 0;

/**
 * The person's browser opens a sign-in link and presses "Continue to sign in": the binding
 * cookie it gets and the WorkOS address it is sent to.
 */
export async function continueSignIn(http: string, loginUrl: string) {
  // The Worker's public URL has no port; the harness listens on an ephemeral one.
  const link = new URL(loginUrl);
  const shown = await fetch(http + link.pathname + link.search, { redirect: "manual" });
  await shown.body?.cancel();
  if (shown.status !== 200) throw new Error(`Sign-in link failed: ${shown.status}`);
  const continued = await fetch(`${http}/v1/account/login/continue`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: publicUrl, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: link.searchParams.get("id") ?? "" }),
  });
  return {
    status: continued.status,
    cookie: continued.headers.get("set-cookie")?.split(";")[0] ?? "",
    authorizeUrl: continued.headers.get("location") ?? "",
  };
}

/**
 * A person signs in to ace through the Worker's real login flow: the app starts a sign-in, the
 * person's browser opens its link and signs in at (fake) WorkOS, and the app claims the session
 * with its private ticket.
 */
export async function signInThroughWorker(
  http: string,
  workos: Awaited<ReturnType<typeof fakeWorkos>>,
  person: WorkosUser,
): Promise<AceAccountGrant> {
  const started = await fetch(`${http}/v1/account/login`, {
    method: "POST",
    headers: { Origin: allowedOrigin },
  });
  if (started.status !== 201) throw new Error(`Sign-in start failed: ${started.status}`);
  const flow = AceLogin.parse(await started.json());
  const { cookie, authorizeUrl } = await continueSignIn(http, flow.loginUrl);
  const code = `code-${++codes}`;
  const state = workos.authorize(authorizeUrl, person, code);
  const callback = await fetch(`${http}/v1/account/callback?state=${state}&code=${code}`, {
    headers: { cookie },
  });
  if (callback.status !== 200) throw new Error(`Sign-in callback failed: ${callback.status}`);
  const claimed = await fetch(`${http}/v1/account/login/${flow.id}`, {
    headers: { Authorization: `Bearer ${flow.secret}` },
  });
  const status = AceLoginStatus.parse(await claimed.json());
  if (status.status !== "complete") throw new Error("Sign-in did not finish");
  return status.session;
}
