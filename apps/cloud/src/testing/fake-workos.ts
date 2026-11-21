import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fakeWorkosOrgs } from "./fake-workos-orgs.ts";

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export type WorkosUser = {
  id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  profile_picture_url?: string | null;
  /** WorkOS verified the email: the backend mints market grants only then. */
  email_verified?: boolean;
};

/** A one-pixel PNG: what the fake serves as a profile picture. */
export const FAKE_PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  "base64",
);

/** A request the fake received, for `holdNext` and `failNext` to pick. */
export type FakeRequest = { method: string; path: string; body: Record<string, unknown> };
type Hold = {
  matches: (request: FakeRequest) => boolean;
  when: "before" | "after";
  entered: () => void;
  released: Promise<void>;
};

/**
 * WorkOS's User Management API, as far as ace uses it: authorization codes checked against
 * their PKCE challenge, and single-use refresh tokens that rotate on every refresh. A spent
 * refresh token presented again is counted (`reusedRefreshTokens`): real WorkOS may take that
 * as theft and end the session.
 */
export async function fakeWorkos() {
  const orgs = fakeWorkosOrgs("client_test");
  const codes = new Map<string, { user: WorkosUser; challenge: string; invitation?: string }>();
  const refreshTokens = new Map<string, WorkosUser>();
  const spent = new Set<string>();
  let reused = 0;
  const holds: Hold[] = [];
  const failures: { matches: (request: FakeRequest) => boolean; status: number; left: number }[] =
    [];
  /** Waits on the first hold for this request at `when`, and spends it. */
  async function holding(request: FakeRequest, when: Hold["when"]) {
    const index = holds.findIndex((each) => each.when === when && each.matches(request));
    const hold = holds[index];
    if (!hold) return;
    holds.splice(index, 1);
    hold.entered();
    await hold.released;
  }
  let failure: "invalid_grant" | "unavailable" | undefined;
  let barrier: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  let issued = 0;

  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      void (async () => {
        const seen: FakeRequest = {
          method: request.method ?? "GET",
          path: new URL(request.url ?? "/", "http://fake").pathname,
          body: (() => {
            try {
              const parsed: unknown = raw ? JSON.parse(raw) : {};
              return typeof parsed === "object" && parsed !== null
                ? (parsed as Record<string, unknown>)
                : {};
            } catch {
              return {};
            }
          })(),
        };
        await holding(seen, "before");
        const injected = failures.find((each) => each.left > 0 && each.matches(seen));
        if (injected) {
          injected.left--;
          return reply(response, injected.status, { message: "Injected failure" });
        }
        // What the fake decided is held back, as a slow answer would be, before it is sent.
        const send = async (status: number, body: unknown) => {
          await holding(seen, "after");
          reply(response, status, body);
        };
        // Where WorkOS keeps profile pictures: an image, and a page that isn't one.
        if (request.url === "/pictures/person.png") {
          response.writeHead(200, { "Content-Type": "image/png" });
          return response.end(FAKE_PICTURE);
        }
        if (request.url === "/pictures/not-an-image")
          return reply(response, 200, { message: "not an image" });
        if (request.url !== "/user_management/authenticate" || request.method !== "POST") {
          // The JWKS is public; every other WorkOS API needs the API key.
          const publicPath = request.url === "/sso/jwks/client_test";
          if (!publicPath && request.headers.authorization !== "Bearer sk_test_backend")
            return reply(response, 401, { message: "Unauthorized" });
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          const answer = orgs.handle(
            request.method ?? "GET",
            new URL(request.url ?? "/", "http://fake"),
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, unknown>)
              : {},
            request.headers,
          );
          return answer ? send(answer.status, answer.body) : send(404, { message: "Not found" });
        }
        const body = JSON.parse(raw) as Record<string, string>;
        if (body.client_id !== "client_test" || body.client_secret !== "sk_test_backend")
          return reply(response, 401, { error: "invalid_client" });
        if (failure === "unavailable") return reply(response, 503, { message: "Unavailable" });
        if (failure === "invalid_grant") return reply(response, 400, { error: "invalid_grant" });
        let user: WorkosUser | undefined;
        let organization: string | undefined;
        let accessToken = "access";
        if (body.grant_type === "authorization_code") {
          const entry = codes.get(body.code ?? "");
          codes.delete(body.code ?? "");
          const challenge = createHash("sha256")
            .update(body.code_verifier ?? "")
            .digest("base64url");
          if (entry?.challenge === challenge) user = entry.user;
          if (user && entry?.invitation)
            organization = orgs.acceptInvitation(entry.invitation, user.id);
          entered?.();
          if (barrier) await barrier;
        } else if (body.grant_type === "refresh_token") {
          user = refreshTokens.get(body.refresh_token ?? "");
          if (user && body.organization_id) {
            // A refusal leaves the refresh token as it was.
            const into = orgs.refreshInto(user.id, body.organization_id);
            if (!("accessToken" in into)) return send(into.status, into.body);
            accessToken = into.accessToken;
            organization = body.organization_id;
          }
          if (!user && spent.has(body.refresh_token ?? "")) reused++;
          refreshTokens.delete(body.refresh_token ?? "");
          spent.add(body.refresh_token ?? "");
        }
        if (!user) return send(400, { error: "invalid_grant" });
        const refresh = `workos-refresh-${++issued}`;
        refreshTokens.set(refresh, user);
        await send(200, {
          user,
          access_token: accessToken,
          refresh_token: refresh,
          ...(organization ? { organization_id: organization } : {}),
        });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    /** The person signs in at WorkOS: the authorization URL's challenge gets a code. */
    authorize(authorizeUrl: string, user: WorkosUser, code: string) {
      const url = new URL(authorizeUrl);
      const invitation = url.searchParams.get("invitation_token") ?? undefined;
      codes.set(code, {
        user,
        challenge: url.searchParams.get("code_challenge") ?? "",
        ...(invitation ? { invitation } : {}),
      });
      orgs.knowUser({
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
      });
      return url.searchParams.get("state") ?? "";
    },
    /** WorkOS's organization APIs and what they recorded. */
    orgs,
    fail(mode?: "invalid_grant" | "unavailable") {
      failure = mode;
    },
    /**
     * Revokes every session of one user, as WorkOS does when the user is deactivated or their
     * directory deprovisions them: each of their refresh tokens is refused from then on.
     */
    revokeSessions(userId: string) {
      for (const [token, user] of refreshTokens)
        if (user.id === userId) refreshTokens.delete(token);
    },
    /** Holds the next code exchange until `release`; resolves once WorkOS has it. */
    hold() {
      const held = Promise.withResolvers<void>();
      barrier = held.promise;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return {
        started,
        release: () => {
          barrier = undefined;
          held.resolve();
        },
      };
    },
    /** Refresh tokens WorkOS would still accept. */
    liveRefreshTokens: () => [...refreshTokens.keys()],
    /** How many times a refresh token already spent was presented again. */
    reusedRefreshTokens: () => reused,
    /**
     * Holds the next request `matches` picks until `release`: `before` WorkOS acts on it, or
     * `after` it acted, with its answer not yet sent. `started` resolves once it is held.
     */
    holdNext(matches: (request: FakeRequest) => boolean, when: Hold["when"] = "after") {
      const released = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      holds.push({ matches, when, entered: started.resolve, released: released.promise });
      return { started: started.promise, release: () => released.resolve() };
    },
    /** Answers the next `times` requests `matches` picks with `status`, doing nothing. */
    failNext(matches: (request: FakeRequest) => boolean, status = 500, times = 1) {
      failures.push({ matches, status, left: times });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
