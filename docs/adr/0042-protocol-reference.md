# 0042: Generated protocol reference and release compatibility

Date: 2026-10-02. Status: accepted.

## Context

Our web, desktop and mobile clients need the same daemon contract as third-party clients. The supplied competitor inventories describe t3code's session-scoped MCP tools, Codex and Claude remote clients, Cursor's MCP integration and Antigravity's remote dashboard. They do not establish a generated, versioned reference for a shared canonical multi-agent protocol. These inventories inform requirements only. No competitor implementation is used.

`packages/protocol` already owns wire schemas. ADR 0004 makes canonical events authoritative, especially whole-tree status. Handwritten copies of these types would drift as parallel workstreams extend the daemon.

## Decision

Add `@ace/protocol-docs` in `tools/protocol-docs`. Discover every exported Zod schema through the protocol package's public entry point. Convert with [Zod 4's native conversion](https://zod.dev/json-schema), input mode and Draft 2020-12. Input mode describes JSON accepted on the wire, including omitted defaulted fields. Give each exported name a stable versioned `$id` and use registry references between files. Export MCP definitions through a small public catalog in `@ace/mcp-server`; runtime registration and documentation use the same definitions.

Generate a reference index and separate pages for commands, client requests, server results and push messages, canonical events, MCP tools and supporting types. List union variants and fields from the converted schemas. Generate bounded, deterministic examples, validate each example with its source Zod schema and a JSON Schema validator, and fail rather than publish an invalid example.

No messages or protocol version changes are introduced. Protocol version 1 is the current handshake contract. Optional fields, new messages and wider types are additive only when consumers tolerate unknown fields and messages. Removed fields, renamed fields, narrowed types and newly required fields require a negotiated new protocol version. Persist released schema snapshots outside the generated directory. Release tooling supplies the last released snapshot explicitly, so this pre-release repository does not invent a released baseline.

## Semantic constraints and unsupported constructs

Standard JSON Schema cannot express comparisons between sibling values or validate an IANA time zone against the runtime's installed data. Existing custom refinements get source-owned descriptions and an explicit `x-ace-constraint` annotation. The export describes structural validation plus these named semantic requirements; full validation still requires Zod or equivalent application checks. Every reference page explains this boundary. Arbitrary refinements, transformations, coercion and unrepresentable Zod constructs fail with the owning schema's name. Never use Zod's permissive unrepresentable fallback. Accept the MIT-licensed Ajv, ajv-formats, randexp and fast-check dependencies for independent JSON Schema validation, bounded examples and property testing.

## Compatibility

Compare snapshots by stable exported names and recursively resolved references. Report schema and field removal, additions, requiredness, types, union branches, enums and constraints. Treat an unfamiliar changed validation keyword or semantic rule as requiring review and fail the release check conservatively. The check is deliberately bidirectional for field removal: a server removing a field can break an existing reader even if a parser would accept its absence. A rename is a removal plus an addition. Documentation-only changes do not affect compatibility.

Release tooling calls `bun run docs:protocol:compat --baseline PATH`. The baseline is a bounded, validated JSON manifest, never executable code. The command exits nonzero on breaking or indeterminate changes. `bun run docs:protocol:snapshot --output PATH` captures a release baseline.

## Security and performance

Generation runs locally without starting the daemon, invoking provider CLIs or obtaining credentials. Examples use synthetic identifiers and dummy credentials. Never load user state or provider config. Output paths come from a fixed generator namespace; stale output files are removed only within that directory. Snapshot input has byte and recursion limits. Generated documentation has no authentication authority.

The drift check performs native schema conversion and compares a generated fingerprint of the schemas, MCP definitions, production sources and lockfile. It then verifies every output's byte length and SHA-256 digest, including missing and unexpected files. Generation validates examples and writes the manifest with its deterministic output; the check avoids recompiling example validators. It must finish under two seconds in normal local conditions. Bounds cover schema count, traversal depth, example attempts and snapshot bytes. No daemon hot path is added. A non-gating benchmark records generation, check time and peak RSS. Disk work lives in a thin CLI/file shell; conversion, rendering and compatibility decisions are pure.

## Testing

Use seeded property tests to generate random JSON candidates, retain values accepted by the source Zod schemas and validate them against the exported JSON Schema with an independent validator. Cover every export and every documented union variant. Test additive and breaking compatibility, rename, reference changes, constraints, unsupported constructs and semantic annotations. Use temporary directories to prove a stale or unexpected file fails the drift check and regeneration repairs it. Per the repo owner’s updated verification policy, run only formatting, lint, type and size checks before opening the PR. Keep the behavior tests and at least eight planned production mutation cases; tests, mutation runs, drift execution and performance measurements need run at merge.
