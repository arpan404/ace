/*
 * Contracts out (ADR 0202 §3, §6): Spade's MCP and A2A endpoints on the outside listener, for
 * the person's own agents. This shell decides who may reach them and passes the rest to Spade:
 *
 * - Every request but the public key needs a token of a live outside grant (ADR 0122) issued
 *   for this base, and the grant must hold `spade-contracts`; Spade's own grant never calls out
 *   here. No token is a 401 naming the resource's metadata; a grant without the scope is a 403
 *   `insufficient_scope`, so the client can ask the person for it. Nothing reaches Spade then.
 * - What is let through goes to Spade with the grant stamped on it (`ace:outside:<grant>`, the
 *   client's name), signed with ace's local token over the method, Spade's route, the protocol
 *   headers, the body and a fresh nonce (`outside-proof.ts`). Spade takes nothing that isn't,
 *   and each nonce once, so its bearer alone can't speak for a client and a captured request
 *   can't be sent again.
 * - The Agent Card is Spade's, given its address here and signed with this machine's card key;
 *   the key's JWK set is public. Both answer an ETag and a short max-age with must-revalidate,
 *   and a matching If-None-Match gets a 304, so a verifier sees a rotated key within minutes.
 */
import { createHash } from "node:crypto";
import type { OutsideGrant } from "@ace/protocol";
import { spadeRequest, type SpadeConnection } from "@ace/service/spade";
import { resourceMetadataUrl, resourceOf, type OutsideBase, type SpadePath } from "./oauth/base.ts";
import { canonicalJson, signCard, type CardKey } from "./card-signature.ts";
import { outsideProof, signedHeaders } from "./outside-proof.ts";

/** The largest message passed on: a 64 KiB input and its envelope, as Spade takes it. */
const maxBodyBytes = 256 * 1024;
/** The largest answer read back: a 256 KiB output and its envelope. */
const maxAnswerBytes = 1024 * 1024;
/** The A2A version the card's interface speaks. */
const a2aVersion = "1.0";
/** How long a verifier may keep the card's public key before it asks again. */
const jwksMaxAge = 300;
/** Characters a stamped name keeps, as the machine stamps do: within Spade's header cap. */
const maxStampedName = 100;
const quotable = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

export interface SpadeContractsDeps {
  /** The live grant a token names at a resource; undefined for any other token. */
  verify(token: string, resource: string): OutsideGrant | undefined;
  touch(grant: OutsideGrant): void;
  /** Spade's address and token, while it runs. */
  spade(): SpadeConnection | undefined;
  /** ace's local token, which signs what reaches Spade; undefined when it can't be read. */
  key(): string | undefined;
  /** This machine's card key, as its file holds it now. */
  cardKey(): CardKey;
  now(): number;
  /** A fresh nonce for each request's stamp: 16 to 128 URL-safe characters. */
  nonce(): string;
}

function challenge(parameters: Record<string, string>): string {
  const listed = Object.entries(parameters)
    .filter(([, value]) => quotable.test(value))
    .map(([key, value]) => `${key}="${value}"`);
  return `Bearer ${listed.join(", ")}`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

interface Stamp {
  key: string;
  time: number;
  nonce: string;
  method: string;
  route: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** The stamp Spade checks: the grant as sender and the client's name, signed with the rest. */
function stamped(grant: OutsideGrant, stamp: Stamp) {
  const sender = `ace:outside:${grant.id}`;
  const name = encodeURIComponent(Array.from(grant.name).slice(0, maxStampedName).join(""));
  return {
    "x-ace-from-host": sender,
    "x-ace-from-name": name,
    "x-ace-inbox-time": String(stamp.time),
    "x-ace-outside-nonce": stamp.nonce,
    "x-ace-inbox-proof": outsideProof(stamp.key, { ...stamp, sender, name }),
  };
}

/** Whether `request` already holds the representation tagged `etag`. */
function fresh(request: Request, etag: string): boolean {
  const asked = request.headers.get("if-none-match");
  if (asked === null) return false;
  return asked
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

function notModified(etag: string, cacheControl: string): Response {
  return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
}

async function bounded(request: Request): Promise<Buffer | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBodyBytes) return undefined;
  const body = Buffer.from(await request.arrayBuffer());
  return body.length > maxBodyBytes ? undefined : body;
}

export function spadeContracts(deps: SpadeContractsDeps) {
  /** The caller's grant, or the answer that refuses it; `resource` names its metadata. */
  function admit(request: Request, base: OutsideBase, resource: SpadePath) {
    const metadata = resourceMetadataUrl(base, resource);
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const grant = bearer ? deps.verify(bearer, resourceOf(base)) : undefined;
    if (!grant || grant.clientKind === "spade")
      return {
        refused: json({ error: "invalid_token" }, 401, {
          "www-authenticate": challenge({ resource_metadata: metadata }),
        }),
      };
    if (!grant.scopes.includes("spade-contracts"))
      return {
        refused: json(
          {
            error: "insufficient_scope",
            scope: "spade-contracts",
            error_description: "Calling the person's Spade bots needs the spade-contracts scope.",
          },
          403,
          {
            "www-authenticate": challenge({
              error: "insufficient_scope",
              scope: "spade-contracts",
              resource_metadata: metadata,
            }),
          },
        ),
      };
    deps.touch(grant);
    return { grant };
  }

  /** One request to Spade for `grant`; Spade's answer, or why there is none. */
  async function forward(
    grant: OutsideGrant,
    method: "GET" | "POST",
    path: string,
    body: Buffer,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const connection = deps.spade();
    const key = deps.key();
    if (!connection || !key) return json({ error: "Spade isn't running on this machine." }, 503);
    let answer;
    try {
      answer = await spadeRequest(
        connection,
        {
          method,
          path,
          ...(method === "POST" ? { body, contentType: "application/json" } : {}),
          headers: {
            ...headers,
            ...stamped(grant, {
              key,
              time: deps.now(),
              nonce: deps.nonce(),
              method,
              route: path,
              headers,
              body,
            }),
          },
        },
        { signal, maxBytes: maxAnswerBytes },
      );
    } catch {
      return json({ error: "Spade didn't answer." }, 502);
    }
    if (answer.kind === "too_large") return json({ error: "Spade's answer was too large." }, 502);
    // A notification's 202 has no body; anything else is Spade's JSON, passed back as it was.
    return new Response(answer.status === 202 ? null : new Uint8Array(answer.body), {
      status: answer.status,
      headers: {
        "content-type": answer.contentType ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }

  async function card(grant: OutsideGrant, base: OutsideBase, request: Request) {
    const answer = await forward(
      grant,
      "GET",
      "/v1/outside/card",
      Buffer.alloc(0),
      {},
      request.signal,
    );
    if (answer.status !== 200) return answer;
    const body: unknown = await answer.json();
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return json({ error: "Spade's card can't be read." }, 502);
    const addressed = {
      ...body,
      supportedInterfaces: [
        { url: `${base.url}/spade/a2a`, protocolBinding: "JSONRPC", protocolVersion: a2aVersion },
      ],
    };
    const signed = signCard(addressed, deps.cardKey(), `${base.url}/spade/jwks.json`);
    const { signatures: _signatures, ...payload } = signed;
    // Tagged by what it says and the key that signs it, so a rotation is a new card.
    const tag = createHash("sha256")
      .update(`${deps.cardKey().jwk.kid}\n${canonicalJson(payload)}`)
      .digest("base64url");
    const etag = `"${tag}"`;
    const cacheControl = "private, max-age=60, must-revalidate";
    if (fresh(request, etag)) return notModified(etag, cacheControl);
    return json(signed, 200, { "cache-control": cacheControl, etag });
  }

  function jwks(request: Request): Response {
    const key = deps.cardKey();
    const etag = `"${key.jwk.kid}"`;
    const cacheControl = `public, max-age=${jwksMaxAge}, must-revalidate`;
    if (fresh(request, etag)) return notModified(etag, cacheControl);
    return json({ keys: [key.jwk] }, 200, { "cache-control": cacheControl, etag });
  }

  /** Serves `path` below `base`, one of `spadeContractPaths` (`oauth/base.ts`). */
  return async (request: Request, base: OutsideBase, path: string): Promise<Response> => {
    const method = request.method;
    if (path === "/spade/jwks.json")
      return method === "GET"
        ? jwks(request)
        : new Response(null, { status: 405, headers: { allow: "GET" } });
    if (path === "/.well-known/agent-card.json") {
      if (method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      const admitted = admit(request, base, "/spade/a2a");
      return admitted.grant ? card(admitted.grant, base, request) : admitted.refused;
    }
    const resource = path === "/spade/mcp" ? "/spade/mcp" : "/spade/a2a";
    // Stateless: one POST per message, no server stream to open and no session to end.
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const admitted = admit(request, base, resource);
    if (!admitted.grant) return admitted.refused;
    const body = await bounded(request);
    if (!body) return json({ error: "The message is too large." }, 413);
    const passed: Record<string, string> = {};
    for (const name of signedHeaders) {
      const value = request.headers.get(name);
      if (value !== null) passed[name] = value;
    }
    // The client going away aborts Spade's request too: for MCP that is the caller's Stop.
    return forward(
      admitted.grant,
      "POST",
      resource === "/spade/mcp" ? "/v1/outside/mcp" : "/v1/outside/a2a",
      body,
      passed,
      request.signal,
    );
  };
}
