// SPDX-License-Identifier: Apache-2.0

/*
 * The one place transport ownership changes (ADR 0226, docs/transport/porting-guide.md rule 4).
 *
 * `scripts/generate-transport-routes.ts` writes `native/daemon/catalog/routes.json` from the
 * client message schemas and from this file, and `bun run check:daemon-native` fails when the
 * two disagree. Moving a message type to Rust is one line in `messageOwners` plus its handler;
 * the generated file is never hand-edited.
 */

/** TypeScript on the daemon's main thread, or a Rust crate (`rust:<crate>`). */
export type Owner = "js:main" | `rust:${string}`;

/**
 * Overrides only: a client message type not named here is owned by `js:main`. Every key must be
 * a type a schema defines, or the generator fails.
 */
export const messageOwners: Record<string, Owner> = {};

/**
 * Each listener's HTTP request chain in order (behaviour.md §3): the first handler that claims a
 * request answers it. The generator writes these rows to `routes.json` as they are.
 */
export const httpStages: readonly {
  listener: "loopback" | "remote";
  stage: string;
  owner: "js" | `rust:${string}`;
}[] = [
  // Loopback: org gate, MCP and Spade's machine grant, then the page and asset handlers.
  { listener: "loopback", stage: "org-gate", owner: "js" },
  { listener: "loopback", stage: "mcp", owner: "js" },
  { listener: "loopback", stage: "spade-grant", owner: "js" },
  { listener: "loopback", stage: "web", owner: "js" },
  { listener: "loopback", stage: "attachments", owner: "js" },
  { listener: "loopback", stage: "icons", owner: "js" },
  { listener: "loopback", stage: "suits", owner: "js" },
  { listener: "loopback", stage: "preview", owner: "js" },
  { listener: "loopback", stage: "access", owner: "js" },
  // Remote (paired devices): the org gate, outside MCP clients, then the machine routes.
  { listener: "remote", stage: "org-gate", owner: "js" },
  { listener: "remote", stage: "outside-mcp", owner: "js" },
  { listener: "remote", stage: "transfers", owner: "js" },
  { listener: "remote", stage: "machine-calls", owner: "js" },
  { listener: "remote", stage: "web", owner: "js" },
  { listener: "remote", stage: "attachments", owner: "js" },
  { listener: "remote", stage: "icons", owner: "js" },
  { listener: "remote", stage: "suits", owner: "js" },
  { listener: "remote", stage: "preview", owner: "js" },
  { listener: "remote", stage: "access", owner: "js" },
];
