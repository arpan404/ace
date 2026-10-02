# Protocol documentation tooling

`@ace/protocol-docs` discovers public Zod exports and converts them with Zod 4's native Draft 2020-12 conversion. MCP registration and docs share `builtinToolCatalog` from `@ace/mcp-server`. No daemon or provider process runs.

```sh
bun run docs:protocol
bun run docs:protocol --check
bun run docs:protocol:snapshot --output release.json
bun run docs:protocol:compat --baseline release.json
bun run --filter @ace/protocol-docs bench
```

The compatibility command prints a JSON array of additive, breaking and review changes. Exit 0 means no breaking or review findings; exit 1 means release tooling must resolve them. It resolves references in both snapshots, so an unchanged reference can still point to a changed type. It checks field removal even for optional fields because an old reader may depend on that field. Unknown changed validation keywords require review. This is a conservative release gate, not a proof of language inclusion for arbitrary JSON Schema.

Capture the snapshot from the released checkout, publish it with release artifacts, and pass that immutable file into the next release check. No release baseline exists yet. Store snapshots outside `docs/protocol`, which the generator owns and cleans. The parser limits inputs to 8 MiB, 1024 schemas and depth 64.

Add a schema export to the protocol public entry point and regenerate. Stable ids use the handshake's protocol version and exported name, so renaming an export is a compatibility change. Input mode preserves omission of defaulted fields. MCP structured result definitions use output mode. Every top-level union alternative gets a source-validated example. The property tests walk Zod independently and then validate accepted JSON values against Ajv.

A custom refinement must declare its semantic rule through source metadata `x-ace-constraint`. Standard JSON Schema cannot compare sibling cursors or consult the runtime's time-zone database. Readers must implement those explicitly documented checks or use Zod. Unannotated refinements, transforms, coercion, overwritten parsers, file schemas and unrepresentable constructs fail with the owning schema's name. The generator never falls back to an unconstrained schema.

Generated JSON and Markdown use deterministic serialization and are excluded from oxfmt. The drift check is their formatting and freshness gate. Its manifest fingerprints converted schemas, MCP definitions, production source code and the lockfile, then verifies every generated file by byte length and SHA-256. Changing schema semantics or the renderer invalidates the fingerprint even when the converted JSON Schema stays the same. Generation always validates the examples; the check reuses their verified output. Benchmarks are informational; wall-clock assertions do not gate tests.
