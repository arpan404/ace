/*
 * Outside grants' tokens (ADR 0122). Tokens are random and only their SHA-256 hashes are kept.
 * An access token lasts an hour; a refresh token works once and is replaced on use, and
 * presenting one already replaced revokes its grant. No token outlives its grant. The OAuth
 * endpoints call `issuePair` after approval and `rotate` at /token; `ace mcp enroll` calls
 * `issueBearer`.
 *
 * An OAuth pair is bound to the resource it was issued for (RFC 8707): the MCP URL of one way
 * in, such as `https://cloud.acehq.dev/m/<hostId>/mcp`. It works there and nowhere else. A pasted
 * token is for the loopback endpoint `ace mcp enroll` prints. ace's relay still answers at its
 * former address and states the origin the caller used, so a pair issued for
 * `https://relay.acehq.dev/m/<hostId>/mcp` keeps working there.
 */
import { createHash } from "node:crypto";
import type { OutsideGrant } from "@ace/protocol";
import type { GrantSql, GrantStore } from "./grants.ts";

/** Supplies cryptographically random bytes; tests pass their own. */
export type RandomBytes = (size: number) => Buffer;

export const accessTokenTtlMs = 60 * 60 * 1000;
/** How long a client that lost a /token reply may present the refresh token it just traded. */
export const refreshGraceMs = 60_000;
/**
 * How long a traded refresh token is kept to catch its reuse. Past it, presenting the token is
 * refused as unknown rather than revoking the grant.
 */
export const spentRefreshKeptMs = 30 * 86_400_000;

export interface TokenPair {
  /** The grant the pair acts for. */
  grantId: string;
  accessToken: string;
  /** When the access token stops working; never after the grant's own expiry. */
  accessExpiresAt: number;
  refreshToken: string;
  /** Null: until the grant is revoked. */
  refreshExpiresAt: number | null;
}
/** Why a refresh was refused, as the OAuth `invalid_grant` error's cause. */
export type RotateRefusal = "unknown" | "expired" | "reused" | "mismatch";
/** Who presents a refresh token, and where: both must match what the pair was issued to. */
export interface RefreshAt {
  clientId: string;
  resource: string;
}

type Kind = "access" | "refresh" | "bearer";

export interface GrantTokensOptions {
  sql: GrantSql;
  grants: GrantStore;
  now: () => number;
  random: RandomBytes;
  /** Told when a grant was revoked here (a refresh token presented twice). */
  revoked?: (grantId: string) => void;
}

const tokenShape = /^[A-Za-z0-9_-]{43}$/;
function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** Whether a resource URL is this machine's loopback endpoint, where pasted tokens work. */
export function loopbackResource(resource: string): boolean {
  try {
    const { protocol, hostname } = new URL(resource);
    return protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}
function earlier(a: number, b: number | null): number {
  return b === null ? a : Math.min(a, b);
}

export class GrantTokens {
  private options: GrantTokensOptions;
  constructor(options: GrantTokensOptions) {
    this.options = options;
  }
  /** A new access and refresh token for a live grant, usable only at `resource`. */
  issuePair(grant: OutsideGrant, resource: string): TokenPair {
    return this.options.sql.atomic(() => this.mintPair(grant, resource, this.options.now()).pair);
  }
  /**
   * The pasted token `ace mcp enroll` prints. It has no expiry of its own: it lasts exactly as
   * long as its grant, which is read on every check, so extending the grant extends it.
   */
  issueBearer(grant: OutsideGrant): string {
    return this.mint(grant.id, "bearer", null, null, null).token;
  }
  /**
   * The live grant an access or pasted token belongs to; undefined for an unknown, expired or
   * refresh token, one whose grant is revoked or expired, or one issued for another resource.
   * `resource` is the MCP URL the request came in on; undefined accepts only pasted tokens.
   * Reads SQLite on every call.
   */
  verify(token: string, resource?: string): OutsideGrant | undefined {
    if (!tokenShape.test(token)) return undefined;
    const row = this.options.sql
      .statement(
        "SELECT grant_id, kind, expires_at, resource FROM outside_grant_tokens WHERE hash=?",
      )
      .get(hash(token));
    if (!row || (row["kind"] !== "access" && row["kind"] !== "bearer")) return undefined;
    const bound = row["resource"];
    const here =
      typeof bound === "string"
        ? bound === resource
        : resource === undefined || loopbackResource(resource);
    if (!here) return undefined;
    const expiresAt = row["expires_at"];
    if (typeof expiresAt === "number" && expiresAt <= this.options.now()) return undefined;
    return this.options.grants.live(String(row["grant_id"]));
  }
  /**
   * Trades a refresh token for a new pair; the old one stops working. A client whose reply was
   * lost may present the token it just traded again within `refreshGraceMs`: it gets a fresh
   * pair and the pair it never received stops working. Any other spent token revokes the whole
   * grant: one of its two holders is not the client. A token presented by another client or at
   * another resource is refused and changes nothing.
   */
  rotate(refreshToken: string, at: RefreshAt): TokenPair | { refused: RotateRefusal } {
    if (!tokenShape.test(refreshToken)) return { refused: "unknown" };
    const now = this.options.now();
    const outcome = this.options.sql.atomic(() => {
      const key = hash(refreshToken);
      const row = this.options.sql
        .statement(
          "SELECT grant_id, kind, expires_at, rotated_at, successor, resource FROM outside_grant_tokens WHERE hash=?",
        )
        .get(key);
      if (!row || row["kind"] !== "refresh" || typeof row["resource"] !== "string")
        return { refused: "unknown" as const };
      const grantId = String(row["grant_id"]);
      const resource = row["resource"];
      if (resource !== at.resource || this.options.grants.get(grantId)?.clientId !== at.clientId)
        return { refused: "mismatch" as const };
      const grant = this.options.grants.live(grantId);
      const expiresAt = row["expires_at"];
      const rotatedAt = row["rotated_at"];
      if (typeof rotatedAt === "number") {
        const successor = typeof row["successor"] === "string" ? row["successor"] : undefined;
        if (grant && successor && now - rotatedAt <= refreshGraceMs && this.unspent(successor)) {
          // The reply carrying `successor` never arrived: replace it.
          this.dropPair(successor);
          const next = this.mintPair(grant, resource, now);
          this.spend(key, rotatedAt, next.id, grant);
          return { pair: next.pair };
        }
        this.options.grants.revoke(grantId);
        this.revokeTokens(grantId);
        return { refused: "reused" as const, grantId };
      }
      if (!grant || (typeof expiresAt === "number" && expiresAt <= now))
        return { refused: "expired" as const };
      const next = this.mintPair(grant, resource, now);
      this.spend(key, now, next.id, grant);
      return { pair: next.pair };
    });
    if ("pair" in outcome) return outcome.pair;
    if (outcome.refused === "reused") this.options.revoked?.(outcome.grantId);
    return { refused: outcome.refused };
  }
  /** Ends every token of a grant except the spent refresh tokens reuse detection reads. */
  revokeTokens(grantId: string): void {
    this.options.sql
      .statement("DELETE FROM outside_grant_tokens WHERE grant_id=? AND rotated_at IS NULL")
      .run(grantId);
  }
  private mintPair(grant: OutsideGrant, resource: string, now: number) {
    this.prune(now);
    const id = this.options.random(16).toString("hex");
    const access = this.mint(
      grant.id,
      "access",
      earlier(now + accessTokenTtlMs, grant.expiresAt),
      id,
      resource,
    );
    const refresh = this.mint(grant.id, "refresh", grant.expiresAt, id, resource);
    return {
      id,
      pair: {
        grantId: grant.id,
        accessToken: access.token,
        accessExpiresAt: access.expiresAt ?? now + accessTokenTtlMs,
        refreshToken: refresh.token,
        refreshExpiresAt: grant.expiresAt,
      },
    };
  }
  /**
   * Marks a refresh token traded for pair `successor`. It is kept only while reuse detection
   * needs it: until the grant would expire, and never past `spentRefreshKeptMs`.
   */
  private spend(key: string, at: number, successor: string, grant: OutsideGrant): void {
    this.options.sql
      .statement(
        "UPDATE outside_grant_tokens SET rotated_at=?, successor=?, expires_at=? WHERE hash=?",
      )
      .run(at, successor, earlier(at + spentRefreshKeptMs, grant.expiresAt), key);
  }
  /** Whether a pair's refresh token is still the live, untraded one. */
  private unspent(pair: string): boolean {
    return !!this.options.sql
      .statement(
        "SELECT 1 FROM outside_grant_tokens WHERE pair=? AND kind='refresh' AND rotated_at IS NULL",
      )
      .get(pair);
  }
  private dropPair(pair: string): void {
    this.options.sql
      .statement("DELETE FROM outside_grant_tokens WHERE pair=? AND rotated_at IS NULL")
      .run(pair);
  }
  private mint(
    grantId: string,
    kind: Kind,
    expiresAt: number | null,
    pair: string | null,
    resource: string | null,
  ) {
    const token = this.options.random(32).toString("base64url");
    if (!tokenShape.test(token)) throw new Error("Token generator must supply 32 bytes");
    this.options.sql
      .statement(
        "INSERT INTO outside_grant_tokens (hash, grant_id, kind, expires_at, rotated_at, pair, resource) VALUES (?,?,?,?,NULL,?,?)",
      )
      .run(hash(token), grantId, kind, expiresAt, pair, resource);
    return { token, expiresAt };
  }
  /** Expired tokens are useless, and spent refresh tokens past their keeping time. */
  private prune(now: number): void {
    this.options.sql
      .statement("DELETE FROM outside_grant_tokens WHERE expires_at IS NOT NULL AND expires_at<=?")
      .run(now);
  }
}
