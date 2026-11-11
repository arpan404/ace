/*
 * Clients registered through Dynamic Client Registration (RFC 7591), which MCP keeps for clients
 * without a metadata document (ADR 0117). Anyone can register, so a registration proves
 * nothing: the person sees these clients as unverified. One never used for an approved grant
 * expires after a day, and the count is capped.
 */
import { z } from "zod";
import type { GrantSql } from "../grants.ts";
import type { RandomBytes } from "../tokens.ts";
import type { OAuthClient } from "./client.ts";
import { redirectAcceptable } from "./redirects.ts";

export const unusedRegistrationMs = 86_400_000;
export const registrationCap = 512;
const fallbackName = "Unnamed client";

const Request = z.looseObject({
  redirect_uris: z.array(z.string().max(2048)).min(1).max(16),
  client_name: z.string().trim().max(256).optional(),
});
const Row = z.object({
  client_id: z.string(),
  name: z.string(),
  redirect_uris: z.string(),
  created_at: z.number(),
  used_at: z.number().nullable(),
});
const Uris = z.array(z.string());

export type RegistrationResult =
  | { registered: Record<string, unknown> }
  | { error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

export class ClientRegistrations {
  private sql: GrantSql;
  private now: () => number;
  private random: RandomBytes;
  constructor(options: { sql: GrantSql; now: () => number; random: RandomBytes }) {
    this.sql = options.sql;
    this.now = options.now;
    this.random = options.random;
  }
  /** Registers a public client; the reply is the RFC 7591 client information response. */
  register(body: unknown): RegistrationResult {
    const parsed = Request.safeParse(body);
    if (!parsed.success)
      return { error: "invalid_client_metadata", description: "redirect_uris is required." };
    // Clients list every redirect they might use; the usable ones are kept and the rest
    // dropped, and the reply says which were kept (RFC 7591 §3.2.1).
    const uris = [...new Set(parsed.data.redirect_uris.filter(redirectAcceptable))];
    if (!uris.length)
      return {
        error: "invalid_redirect_uri",
        description:
          "No usable redirect URI: use HTTPS, http on localhost, or an app's own scheme, without a fragment.",
      };
    const name = parsed.data.client_name || fallbackName;
    const now = this.now();
    const clientId = `ace-dcr-${this.random(18).toString("base64url")}`;
    const stored = this.sql.atomic(() => {
      this.prune(now);
      if (this.count() >= registrationCap) {
        // Make room from the oldest client that never signed in.
        this.sql
          .statement(
            "DELETE FROM outside_oauth_clients WHERE client_id = (SELECT client_id FROM outside_oauth_clients WHERE used_at IS NULL ORDER BY created_at, client_id LIMIT 1)",
          )
          .run();
        if (this.count() >= registrationCap) return false;
      }
      this.sql
        .statement(
          "INSERT INTO outside_oauth_clients (client_id, name, redirect_uris, created_at, used_at) VALUES (?,?,?,?,NULL)",
        )
        .run(clientId, name, JSON.stringify(uris), now);
      return true;
    });
    if (!stored)
      return {
        error: "invalid_client_metadata",
        description: "Too many clients are registered on this machine.",
      };
    // Public clients only: whatever method was asked for, there is no secret (RFC 7591 §3.2.1).
    return {
      registered: {
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    };
  }
  /** A registered client that may still sign in. */
  get(clientId: string): OAuthClient | undefined {
    const row = Row.safeParse(
      this.sql
        .statement(
          "SELECT client_id, name, redirect_uris, created_at, used_at FROM outside_oauth_clients WHERE client_id=?",
        )
        .get(clientId),
    );
    if (!row.success) return undefined;
    const { data } = row;
    if (data.used_at === null && data.created_at + unusedRegistrationMs <= this.now())
      return undefined;
    let uris: string[];
    try {
      uris = Uris.parse(JSON.parse(data.redirect_uris));
    } catch {
      return undefined;
    }
    return { kind: "dcr", clientId, name: data.name, domain: null, redirectUris: uris };
  }
  /** The client was approved for a grant: it no longer expires unused. */
  markUsed(clientId: string): void {
    this.sql
      .statement("UPDATE outside_oauth_clients SET used_at=? WHERE client_id=? AND used_at IS NULL")
      .run(this.now(), clientId);
  }
  private prune(now: number): void {
    this.sql
      .statement("DELETE FROM outside_oauth_clients WHERE used_at IS NULL AND created_at<=?")
      .run(now - unusedRegistrationMs);
  }
  private count(): number {
    const row = this.sql.statement("SELECT COUNT(*) AS n FROM outside_oauth_clients").get();
    return Number(row?.["n"] ?? 0);
  }
}
