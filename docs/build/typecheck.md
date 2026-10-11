# Incremental typechecking

`bun run typecheck` runs the TypeScript 7 native compiler with at most two project
builders, one checker per project, and `GOMAXPROCS=2`. The config API and the two
build stages run sequentially, so there is at most one compiler process at a time.

`bun run --filter @ace/protocol typecheck` checks that workspace and its declared
workspace dependency closure, including development dependencies. Package checks
share the same declaration and check caches as a full run. Large test dependency
closures can still pull in many packages.

`bun run typecheck:clean` removes all generated configs, declarations, compiler
build info, and scope metadata. It is safe to delete these caches at any time.

## Build and check stages

The runner reads the workspace manifests and the original tsconfigs. These remain
the authority for checking options and file coverage.

1. Exported workspace entry points produce `.d.ts` files with `composite`,
   `emitDeclarationOnly`, and project references to production dependencies.
   This stage uses `noCheck` to avoid checking the implementations twice. Declaration
   inference and critical parse/emit diagnostics still run.
2. Each original package program runs once with `noCheck: false` and `incremental`.
   The generated config inherits its original options and includes its original
   root files, including tests, fixtures, benchmarks, scripts, and app configs.
   TypeScript-only `paths` resolve other packages' public exports to their cached
   declarations. A package's own sources and self-imports stay in its check program.
3. The root `tsconfig.tests.json` program and the client's `tsconfig.runtime.json`
   guard also run. The client guard keeps its original source resolution, empty
   Node types list, and browser libraries, so declarations cannot conceal an
   accidental Node dependency.

The checking stage has no project references to dependency implementations. This
avoids test dependency cycles and avoids redirecting a package's own sources to
unchecked declarations through a transitive reference. Runtime package exports
continue to point at `.ts` sources. Relative `.ts` imports, Node's direct execution,
strictness, and erasable syntax requirements remain in place.

A few existing cross-workspace relative imports in benchmark and test tooling
still consume sources. The source-based browser guard also deliberately revisits
its dependency sources. Ordinary `@ace/*` imports consume declarations.

Four explicit `AbortSignal` annotations in screen/daemon exports are required for
portable declaration names. They do not change runtime behavior.

## Preserve the original type environment

A dependency's implementation can contribute `/// <reference lib="dom" />`,
global declarations, or module augmentations, even when its public declaration
omits those implementation imports. Dropping them would change existing checks.
Combining package programs would also combine their augmentations.

The installed compiler's config/program API finds the original source graph for
each checking program. The generated check includes its original global files and
augmentations, plus a declaration file forwarding its reference libraries. These
are separate for each program. For example, the daemon retains DOM types supplied
by client implementation imports, and tests retain their Vitest context extensions.

Scope metadata is cached with the source-file inventory and content hashes of the original program files,
resolved options/root files, workspace manifests, the lockfile, and the scope
planner. Changed imports, added/removed root files, changed global declarations,
and changed dependency types trigger a new source-graph inspection. Corrupt or
missing scope metadata triggers inspection too. No success/failure result is stored
by the runner; TypeScript owns diagnostic reuse and incremental invalidation.
Generated config comments include content fingerprints, forcing a fresh build
when input bytes change even if their source timestamps were preserved. Check
fingerprints cover their own roots and globals; dependency declarations drive
downstream compiler invalidation.

The runner uses `typescript/unstable/sync`, the installed package's public config
API export. TypeScript is pinned to 7.0.2 because that API is explicitly unstable.
Compiler upgrades must validate it and cold/warm diagnostic behavior together.

## Cache ownership and CI

Every workspace stores its generated configs, declarations, and separate build
info for emitting/checking beneath `.cache/typecheck/`. Root tooling and scope
metadata use the repository's `.cache/typecheck/`. All these directories are
ignored by Git. Build info for declaration inference cannot replace build info
from a real check.

CI restores these directories with OS/architecture, lockfile, manifests,
tsconfigs, runner code, and commit in the key. The restore prefix reuses a prior
commit with matching tooling; TypeScript and the scope planner still validate the
current inputs. Source changes are not treated as a cache hit that skips checking.
The normal CI typecheck step runs after restoration.

## TypeScript 7 support checked

The installed 7.0.2 `tsc --help --all` and `tsc -b --help` expose build mode,
project references, composite declarations, incremental build info, `noCheck`,
`--builders`, `--checkers`, and `--singleThreaded`. The
[TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
describes the worker controls and their memory tradeoffs. The
[official native compiler repository](https://github.com/microsoft/typescript-go)
records build mode/project references, declarations, and incremental builds as
implemented. The installed API declarations document config parsing, source graphs,
and source-file augmentation/reference metadata.
