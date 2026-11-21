/*
 * The discovery documents each base serves (ADR 0122): protected-resource metadata (RFC 9728)
 * and authorization-server metadata (RFC 8414), the daemon being both. Pure: a base in, JSON out.
 */
import { OutsideScope } from "@ace/protocol";
import { resourceOf, type OutsideBase, type SpadePath } from "./base.ts";

/** What a client asks for when nothing else tells it: reading, the scope every grant has. */
export const baselineScopes: readonly OutsideScope[] = ["threads:read"];

export function protectedResourceMetadata(base: OutsideBase, machine: string) {
  return {
    resource: resourceOf(base),
    authorization_servers: [base.url],
    // The minimum for basic use; more is asked for by step-up (403 insufficient_scope).
    scopes_supported: [...baselineScopes],
    bearer_methods_supported: ["header"],
    resource_name: `ace on ${machine}`,
  };
}

/**
 * The metadata of one of Spade's resources at `base` (ADR 0202 §3, §6): the same authorization
 * server, and the scope its calls need.
 */
export function spadeResourceMetadata(base: OutsideBase, path: SpadePath, machine: string) {
  return {
    resource: `${base.url}${path}`,
    authorization_servers: [base.url],
    scopes_supported: ["spade-contracts"] satisfies OutsideScope[],
    bearer_methods_supported: ["header"],
    resource_name: `Spade's contracts on ${machine}`,
  };
}

export function authorizationServerMetadata(base: OutsideBase) {
  return {
    issuer: base.url,
    authorization_endpoint: `${base.url}/authorize`,
    token_endpoint: `${base.url}/token`,
    registration_endpoint: `${base.url}/register`,
    scopes_supported: [...OutsideScope.options],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
