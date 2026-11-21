import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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

/**
 * WorkOS's User Management API, as far as ace uses it: authorization codes checked against
 * their PKCE challenge, and single-use refresh tokens that rotate on every refresh.
 */
export async function fakeWorkos() {
  const codes = new Map<string, { user: WorkosUser; challenge: string }>();
  const refreshTokens = new Map<string, WorkosUser>();
  let failure: "invalid_grant" | "unavailable" | undefined;
  /** Calls `hold` stops, by kind: the next one waits until released. */
  type Held = "exchange" | "refresh" | "delete";
  const barriers = new Map<Held, { promise: Promise<void>; entered: () => void }>();
  const pause = async (kind: Held) => {
    const barrier = barriers.get(kind);
    if (!barrier) return;
    barrier.entered();
    await barrier.promise;
  };
  let issued = 0;
  let deleteFailure = false;
  const deleted: string[] = [];

  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      void (async () => {
        // Where WorkOS keeps profile pictures: an image, and a page that isn't one.
        if (request.url === "/pictures/person.png") {
          response.writeHead(200, { "Content-Type": "image/png" });
          return response.end(FAKE_PICTURE);
        }
        if (request.url === "/pictures/not-an-image")
          return reply(response, 200, { message: "not an image" });
        const deleting = request.url?.match(/^\/user_management\/users\/([^/]+)$/)?.[1];
        if (deleting && request.method === "DELETE") {
          if (request.headers.authorization !== "Bearer sk_test_backend")
            return reply(response, 401, { message: "Unauthorized" });
          await pause("delete");
          if (deleteFailure) return reply(response, 500, { message: "Internal error" });
          const id = decodeURIComponent(deleting);
          if (deleted.includes(id)) return reply(response, 404, { message: "Not found" });
          for (const [token, held] of refreshTokens)
            if (held.id === id) refreshTokens.delete(token);
          deleted.push(id);
          response.writeHead(202);
          return response.end();
        }
        if (request.url !== "/user_management/authenticate" || request.method !== "POST")
          return reply(response, 404, { message: "Not found" });
        const body = JSON.parse(raw) as Record<string, string>;
        if (body.client_id !== "client_test" || body.client_secret !== "sk_test_backend")
          return reply(response, 401, { error: "invalid_client" });
        if (failure === "unavailable") return reply(response, 503, { message: "Unavailable" });
        if (failure === "invalid_grant") return reply(response, 400, { error: "invalid_grant" });
        let user: WorkosUser | undefined;
        if (body.grant_type === "authorization_code") {
          const entry = codes.get(body.code ?? "");
          codes.delete(body.code ?? "");
          const challenge = createHash("sha256")
            .update(body.code_verifier ?? "")
            .digest("base64url");
          if (entry?.challenge === challenge) user = entry.user;
          await pause("exchange");
        } else if (body.grant_type === "refresh_token") {
          await pause("refresh");
          user = refreshTokens.get(body.refresh_token ?? "");
          refreshTokens.delete(body.refresh_token ?? "");
        }
        if (!user) return reply(response, 400, { error: "invalid_grant" });
        const refresh = `workos-refresh-${++issued}`;
        refreshTokens.set(refresh, user);
        reply(response, 200, { user, access_token: "access", refresh_token: refresh });
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
      codes.set(code, { user, challenge: url.searchParams.get("code_challenge") ?? "" });
      return url.searchParams.get("state") ?? "";
    },
    fail(mode?: "invalid_grant" | "unavailable") {
      failure = mode;
    },
    /**
     * Holds the next code exchange (or token refresh, or user delete) and every one after it
     * until `release`; `started` resolves once the first has reached WorkOS.
     */
    hold(kind: Held = "exchange") {
      const held = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      barriers.set(kind, { promise: held.promise, entered: started.resolve });
      return {
        started: started.promise,
        release: () => {
          barriers.delete(kind);
          held.resolve();
        },
      };
    },
    /** While on, deleting a user answers 500. */
    failDeletes(on: boolean) {
      deleteFailure = on;
    },
    /** The users WorkOS was asked to delete, in order. */
    deletedUsers: () => [...deleted],
    /** Refresh tokens WorkOS would still accept. */
    liveRefreshTokens: () => [...refreshTokens.keys()],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
