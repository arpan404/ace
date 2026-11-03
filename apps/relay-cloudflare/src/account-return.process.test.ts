import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { AceLogin, AceLoginStatus } from "@ace/protocol/ace-account";
import { fakeWorkos } from "./testing/fake-workos.ts";
import type { WorkosUser } from "./testing/fake-workos.ts";
import { allowedOrigin, startWorker } from "./testing/harness.ts";
import { continueSignIn } from "./testing/sign-in.ts";
import { publicUrl } from "./testing/worker.ts";

// The sign-in link page and return addresses (ADR 0100). Its own Worker: the account API's
// per-address rate limit is shared by every request in a file.
let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startWorker({ workosUrl: workos.url });
});
afterEach(() => workos.fail());
afterAll(async () => {
  await worker.close();
  await workos.close();
});

const personA: WorkosUser = {
  id: "user_a",
  email: "a@example.com",
  first_name: "Ace",
  last_name: "Person",
};
let codes = 0;

const request = (path: string, init?: RequestInit) =>
  fetch(worker.http + path, { redirect: "manual", ...init });
const poll = (flow: AceLogin) =>
  request(`/v1/account/login/${flow.id}`, { headers: { Authorization: `Bearer ${flow.secret}` } });
const startLogin = (body?: unknown) =>
  request("/v1/account/login", {
    method: "POST",
    headers: { Origin: allowedOrigin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const continueWith = (id: string, origin?: string) =>
  request("/v1/account/login/continue", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(origin ? { Origin: origin } : {}),
    },
    body: new URLSearchParams({ id }),
  });

const location = (response: Response) => response.headers.get("location");

async function begin(returnTo?: string) {
  const started = await startLogin(returnTo === undefined ? undefined : { returnTo });
  expect(started.status).toBe(201);
  const flow = AceLogin.parse(await started.json());
  const continued = await continueSignIn(worker.http, flow.loginUrl);
  expect(continued.status).toBe(302);
  return { flow, cookie: continued.cookie, authorizeUrl: continued.authorizeUrl };
}

function returnFromWorkos(
  started: { cookie: string; authorizeUrl: string },
  cookie = started.cookie,
) {
  const code = `code-${++codes}`;
  const state = workos.authorize(started.authorizeUrl, personA, code);
  return request(`/v1/account/callback?state=${state}&code=${code}`, { headers: { cookie } });
}

it("link previews can fetch a sign-in link any number of times without using it up", async () => {
  const started = await startLogin();
  const flow = AceLogin.parse(await started.json());
  const link = new URL(flow.loginUrl);
  for (let visit = 0; visit < 3; visit++) {
    const shown = await request(link.pathname + link.search);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("set-cookie")).toBeNull();
    expect(shown.headers.get("content-security-policy")).toContain("form-action 'self' https:");
    expect(await shown.text()).toContain("Continue to sign in");
  }
  // Only a post from the backend's own page continues; another site can't push a held id.
  expect((await continueWith(flow.id, allowedOrigin)).status).toBe(403);
  expect((await continueWith(flow.id)).status).toBe(403);
  const continued = await continueWith(flow.id, publicUrl);
  expect(continued.status).toBe(302);
  expect(continued.headers.get("set-cookie")).toMatch(/^ace_login_/);
  expect((await continueWith(flow.id, publicUrl)).status).toBe(410);
  expect((await request(link.pathname + link.search)).status).toBe(410);
  // Every other account response keeps the strict policy.
  expect((await poll(flow)).headers.get("content-security-policy")).toContain("form-action 'none'");
});

it("a sign-in returns only to the apps' link or an allowed web origin's landing page", async () => {
  for (const returnTo of ["ace://account/signed-in", `${allowedOrigin}/account/signed-in`])
    expect((await startLogin({ returnTo })).status).toBe(201);
  for (const returnTo of [
    "https://attacker.example/account/signed-in",
    `${allowedOrigin}/settings/general`,
    "app://ace/account/signed-in",
    "ace://account/signed-in?token=x",
  ])
    expect((await startLogin({ returnTo })).status).toBe(400);
  expect((await request("/v1/account/login", { method: "POST", body: "{" })).status).toBe(400);
});

it("the browser returns to the app with only how the sign-in ended", async () => {
  const back = "ace://account/signed-in";
  const signedIn = await begin(back);
  const done = await returnFromWorkos(signedIn);
  expect(done.status).toBe(302);
  expect(location(done)).toBe(`${back}?status=signed-in`);
  // The app still gets its session from its own claim.
  expect(AceLoginStatus.parse(await (await poll(signedIn.flow)).json()).status).toBe("complete");
  expect(location(await returnFromWorkos(signedIn))).toBe(`${back}?status=expired`);

  const cancelled = await begin(back);
  const state = workos.authorize(cancelled.authorizeUrl, personA, "unused");
  const denied = await request(`/v1/account/callback?state=${state}&error=access_denied`, {
    headers: { cookie: cancelled.cookie },
  });
  expect(location(denied)).toBe(`${back}?status=cancelled`);

  const failing = await begin(`${allowedOrigin}/account/signed-in`);
  workos.fail("unavailable");
  expect(location(await returnFromWorkos(failing))).toBe(
    `${allowedOrigin}/account/signed-in?status=failed`,
  );
});

it("a used or unknown sign-in says it expired, and only another browser is unverified", async () => {
  const started = await begin();
  const other = await returnFromWorkos(started, "");
  expect(await other.text()).toContain("could not be verified");
  expect(await (await returnFromWorkos(started)).text()).toContain("You're signed in");
  for (const late of [
    await returnFromWorkos(started),
    await request("/v1/account/callback?state=unknown&code=x"),
  ]) {
    expect(late.status).toBe(410);
    expect(await late.text()).toContain("This sign-in has expired or was already used.");
  }
});
