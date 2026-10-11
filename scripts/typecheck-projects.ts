import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { z } from "zod";
import { TypecheckScopes } from "./typecheck-scope.ts";

const manifestSchema = z.object({
  name: z.string(),
  scripts: z.record(z.string(), z.string()).default({}),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  exports: z.record(z.string(), z.string()).default({}),
});
const pathsSchema = z.record(z.string(), z.array(z.string()));
const optionsSchema = z.object({
  types: z.array(z.string()).default([]),
  paths: pathsSchema.default({}),
  pathsBasePath: z.string().optional(),
});

type Workspace = {
  directory: string;
  manifest: z.infer<typeof manifestSchema>;
  config: string;
  runtime: string;
  checks: string;
  guards: string[];
};

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

function writeConfig(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeProgram(file: string, value: unknown, fingerprint: string): void {
  // Changing inputs invalidates the builder even when their mtimes were preserved.
  writeText(file, `// Source graph content: ${fingerprint}\n${JSON.stringify(value, null, 2)}\n`);
}

function discover(root: string): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const top of ["packages", "apps", "tools"]) {
    for (const entry of readdirSync(join(root, top), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, top, entry.name);
      const manifest = manifestSchema.parse(
        JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
      );
      if (!manifest.scripts.typecheck) continue;
      const cache = join(directory, ".cache/typecheck");
      workspaces.push({
        directory,
        manifest,
        config: join(directory, "tsconfig.json"),
        runtime: join(cache, "runtime.json"),
        checks: join(cache, "checks.json"),
        guards: readdirSync(directory)
          .filter((name) => /^tsconfig\.(?!json$).+\.json$/.test(name))
          .map((name) => join(directory, name)),
      });
    }
  }
  return workspaces;
}

function declarationPaths(workspaces: Workspace[], own?: Workspace): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const workspace of workspaces) {
    if (workspace === own) continue;
    for (const [key, file] of Object.entries(workspace.manifest.exports)) {
      const name =
        key === "." ? workspace.manifest.name : `${workspace.manifest.name}/${key.slice(2)}`;
      paths[name] = [
        resolve(dirname(workspace.runtime), "declarations", file.replace(/\.[cm]?tsx?$/, ".d.ts")),
      ];
    }
  }
  return paths;
}

export function cleanTypecheck(root: string): void {
  for (const directory of [root, ...discover(root).map((workspace) => workspace.directory)]) {
    rmSync(join(directory, ".cache/typecheck"), { recursive: true, force: true });
  }
}

/** Final checks keep every original root file and option. Only dependency package imports use declarations. */
export function prepareTypecheck(
  root: string,
  selected?: string,
): { declarations: string; checks: string } {
  const workspaces = discover(root);
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const selectedWorkspace = workspaces.find((workspace) => workspace.directory === selected);
  if (selected && !selectedWorkspace) throw new Error(`No typecheck workspace at ${selected}`);
  const wanted = new Set<Workspace>();
  function visit(workspace: Workspace): void {
    if (wanted.has(workspace)) return;
    wanted.add(workspace);
    for (const name of Object.keys({
      ...workspace.manifest.dependencies,
      ...workspace.manifest.devDependencies,
    })) {
      const dependency = byName.get(name);
      if (dependency) visit(dependency);
    }
  }
  for (const workspace of selectedWorkspace ? [selectedWorkspace] : workspaces) visit(workspace);
  const api = new API({ cwd: root });
  const cache = join(selected ?? root, ".cache/typecheck");
  const rootChecks = join(cache, "root-checks.json");
  const scopeCache = join(root, ".cache/typecheck/scopes.json");
  const scopes = new TypecheckScopes(
    api,
    root,
    workspaces.map((workspace) => join(workspace.directory, "package.json")),
    scopeCache,
  );
  const guards = new Map<Workspace, string[]>();
  try {
    for (const workspace of wanted) {
      const parsed = api.parseConfigFile(workspace.config);
      if (parsed.fileNames.length === 0) throw new Error(`No inputs found in ${workspace.config}`);
      const options = optionsSchema.parse(parsed.options);
      const scope = scopes.get(workspace.config, parsed);
      const libs = join(dirname(workspace.checks), "reference-libs.d.ts");
      const libText = scope.libs.map((lib) => `/// <reference lib="${lib}" />`).join("\n") + "\n";
      writeText(libs, libText);
      const paths = Object.fromEntries(
        Object.entries(options.paths).map(([name, values]) => [
          name,
          values.map((value) => resolve(options.pathsBasePath ?? workspace.directory, value)),
        ]),
      );
      const references = Object.keys(workspace.manifest.dependencies).flatMap((name) => {
        const dependency = byName.get(name);
        return dependency && Object.keys(dependency.manifest.exports).length
          ? [{ path: dependency.runtime }]
          : [];
      });
      if (Object.keys(workspace.manifest.exports).length)
        writeProgram(
          workspace.runtime,
          {
            extends: workspace.config,
            compilerOptions: {
              composite: true,
              noCheck: true,
              noEmit: false,
              declaration: true,
              emitDeclarationOnly: true,
              // Bind the public testing helpers' Vitest augmentations while emitting.
              // Final checks inherit the original types list without this addition.
              types: [...new Set([...options.types, "vitest"])],
              rootDir: workspace.directory,
              outDir: join(dirname(workspace.runtime), "declarations"),
              tsBuildInfoFile: join(dirname(workspace.runtime), "runtime.tsbuildinfo"),
            },
            files: Object.values(workspace.manifest.exports).map((file) =>
              resolve(workspace.directory, file),
            ),
            include: [],
            references,
          },
          scopes.emitFingerprint(parsed),
        );
      writeProgram(
        workspace.checks,
        {
          extends: workspace.config,
          compilerOptions: {
            noCheck: false,
            incremental: true,
            paths: {
              ...(scope.sourceCheck ? {} : declarationPaths([...wanted], workspace)),
              ...paths,
            },
            tsBuildInfoFile: join(dirname(workspace.checks), "checks.tsbuildinfo"),
          },
          files: [...new Set([...parsed.fileNames, ...scope.globals, libs])],
          include: [],
        },
        scopes.checkFingerprint(parsed, scope),
      );
      const guardProjects: string[] = [];
      for (const guard of workspace.guards) {
        const parsedGuard = api.parseConfigFile(guard);
        const guardScope = scopes.get(guard, parsedGuard);
        const project = join(dirname(workspace.checks), `guard-${basename(guard)}`);
        writeProgram(
          project,
          {
            extends: guard,
            compilerOptions: {
              noCheck: false,
              incremental: true,
              tsBuildInfoFile: `${project}.tsbuildinfo`,
            },
          },
          guardScope.fingerprint,
        );
        guardProjects.push(project);
      }
      guards.set(workspace, guardProjects);
    }
    if (!selected) {
      const config = join(root, "tsconfig.tests.json");
      const parsed = api.parseConfigFile(config);
      const scope = scopes.get(config, parsed);
      const libs = join(cache, "root-reference-libs.d.ts");
      writeText(libs, scope.libs.map((lib) => `/// <reference lib="${lib}" />`).join("\n") + "\n");
      writeProgram(
        rootChecks,
        {
          extends: config,
          compilerOptions: {
            noCheck: false,
            ...(scope.sourceCheck ? {} : { paths: declarationPaths(workspaces) }),
            tsBuildInfoFile: join(cache, "root-checks.tsbuildinfo"),
          },
          files: [...new Set([...parsed.fileNames, ...scope.globals, libs])],
          include: [],
        },
        scopes.checkFingerprint(parsed, scope),
      );
    }
    writeConfig(scopeCache, scopes.serialize());
  } finally {
    api.close();
  }
  const declarations = join(cache, "declarations.json");
  writeConfig(declarations, {
    files: [],
    references: [...wanted]
      .filter((workspace) => Object.keys(workspace.manifest.exports).length)
      .map((workspace) => ({ path: workspace.runtime })),
  });
  const checks = join(cache, "solution.json");
  const references: { path: string }[] = [];
  for (const workspace of wanted) {
    references.push({ path: workspace.checks });
    for (const path of guards.get(workspace) ?? []) references.push({ path });
  }
  if (!selected) {
    references.push({ path: rootChecks });
  }
  writeConfig(checks, { files: [], references });
  return { declarations, checks };
}
