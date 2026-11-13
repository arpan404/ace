import { afterAll, beforeAll, expect, it } from "vitest";
import { AceLogin, AceLoginStatus } from "@ace/protocol/ace-account";
import { fakeWorkos } from "./testing/fake-workos.ts";
import { startWorker } from "./testing/harness.ts";

// Real Worker requests exercise hostname selection, D1 login state and WorkOS PKCE together.
const origins = ["https://cloud.acehq.dev", "https://relay.acehq.dev"];
let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({
    workosUrl: workos.url,
    vars: {
      ACE_ACCOUNT_PUBLIC_URL: origins[0] ?? "",
      ACE_ACCOUNT_PUBLIC_ORIGINS: origins.join(","),
    },
  });
});
afterAll(async () => {
  await worker.close();
  await workos.close();
});

it.each(origins)("sign-in stays on %s through the browser callback and claim", async (origin) => {
  const request = (path: string, init?: Parameters<typeof worker.dispatch>[1]) =>
    worker.dispatch(origin + path, init);
  const started = await request("/v1/account/login", { method: "POST" });
  expect(started.status).toBe(201);
  const flow = AceLogin.parse(await started.json());
  expect(flow.loginUrl).toBe(`${origin}/v1/account/login?id=${flow.id}`);
  const shown = await worker.dispatch(flow.loginUrl);
  expect(shown.status).toBe(200);
  expect(shown.headers.get("set-cookie")).toBeNull();
  expect(await shown.text()).toContain("Continue to sign in");

  const continueWith = (from: string) =>
    request("/v1/account/login/continue", {
      method: "POST",
      headers: { Origin: from, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: flow.id }).toString(),
      redirect: "manual",
    });
  // Even the other configured host cannot submit a form on this host.
  expect((await continueWith(origins.find((other) => other !== origin) ?? "")).status).toBe(403);
  const continued = await continueWith(origin);
  expect(continued.status).toBe(302);
  const cookie = continued.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`ace_login_${flow.id}=`);
  expect(cookie).toContain("; HttpOnly; SameSite=Lax; Path=/v1/account/callback;");
  expect(cookie).toContain("; Secure");
  expect(cookie.toLowerCase()).not.toContain("domain=");
  const authorizeUrl = continued.headers.get("location") ?? "";
  const callback = new URL(authorizeUrl).searchParams.get("redirect_uri");
  expect(callback).toBe(`${origin}/v1/account/callback`);
  const code = `code-${new URL(origin).hostname}`;
  const state = workos.authorize(
    authorizeUrl,
    { id: "user_hosts", email: "hosts@example.com", first_name: "Hosts", last_name: null },
    code,
  );
  const callbackUrl = `${callback}?${new URLSearchParams({ state, code })}`;
  // A browser without this host's binding cookie cannot spend the sign-in.
  expect((await worker.dispatch(callbackUrl)).status).toBe(400);
  const done = await worker.dispatch(callbackUrl, {
    headers: { Cookie: cookie.split(";")[0] ?? "" },
  });
  expect(done.status).toBe(200);
  expect(await done.text()).toContain("You're signed in");
  const cleared = done.headers.get("set-cookie") ?? "";
  expect(cleared).toContain(`ace_login_${flow.id}=;`);
  expect(cleared).toContain("Max-Age=0; Secure");
  expect(cleared.toLowerCase()).not.toContain("domain=");
  const claimed = await request(`/v1/account/login/${flow.id}`, {
    headers: { Authorization: `Bearer ${flow.secret}` },
  });
  expect(AceLoginStatus.parse(await claimed.json())).toMatchObject({
    status: "complete",
    session: { account: { id: "user_hosts" } },
  });
});

it("an unlisted request host cannot start, continue or complete sign-in", async () => {
  for (const [path, method] of [
    ["/v1/account/login", "POST"],
    ["/v1/account/login/continue", "POST"],
    ["/v1/account/callback?state=unknown&code=unused", "GET"],
  ] as const) {
    const denied = await worker.dispatch(`https://unlisted.example${path}`, {
      method,
      headers: { Origin: "app://ace" },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "origin_denied" });
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(denied.headers.get("location")).toBeNull();
  }
});
