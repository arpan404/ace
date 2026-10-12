import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { z } from "zod";
import { needsSourceCheck } from "./typecheck-fallbacks.ts";

const scopeSchema = z.object({
  fingerprint: z.string(),
  files: z.array(z.string()),
  globals: z.array(z.string()),
  libs: z.array(z.string()),
  sourceCheck: z.boolean(),
});
const cacheSchema = z.record(z.string(), scopeSchema);
type Scope = z.infer<typeof scopeSchema>;
type ConfigResponse = ReturnType<API["parseConfigFile"]>;

/** Preserve global declarations, augmentations and reference libs from the original source program. */
export class TypecheckScopes {
  private cache: z.infer<typeof cacheSchema> = {};
  private contents = new Map<string, string>();
  private api: API;
  private root: string;
  private manifests: string[];
  private inventory: string;
  private workspaceDirectories: string[];
  private shapes = new Map<string, { global: boolean; libs: string[] }>();

  constructor(api: API, root: string, manifests: string[], cacheFile: string) {
    this.api = api;
    this.root = root;
    this.manifests = manifests;
    this.workspaceDirectories = manifests.map((file) => resolve(file, ".."));
    const names: string[] = [];
    function visit(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (
          [
            ".git",
            "node_modules",
            ".cache",
            "dist",
            "coverage",
            ".ace-dev",
            ".recordings",
          ].includes(entry.name)
        )
          continue;
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) names.push(file);
      }
    }
    visit(root);
    this.inventory = createHash("sha256").update(JSON.stringify(names.toSorted())).digest("hex");
    try {
      const cached = cacheSchema.safeParse(JSON.parse(readFileSync(cacheFile, "utf8")));
      if (cached.success) this.cache = cached.data;
    } catch {
      // Missing/corrupt planner caches always fall back to the compiler's current source graph.
    }
  }

  private content(file: string): string {
    let hash = this.contents.get(file);
    if (hash === undefined) {
      try {
        hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      } catch {
        hash = "missing";
      }
      this.contents.set(file, hash);
    }
    return hash;
  }

  private contentFingerprint(config: ConfigResponse, files: string[]): string {
    const hash = createHash("sha256").update(JSON.stringify(config));
    for (const file of [
      ...new Set([
        ...files,
        ...this.manifests,
        resolve(this.root, "bun.lock"),
        resolve(this.root, "scripts/typecheck-scope.ts"),
        resolve(this.root, "scripts/typecheck-fallbacks.ts"),
      ]),
    ].toSorted())
      hash.update(file).update(this.content(file));
    return hash.digest("hex");
  }

  private graphFingerprint(config: ConfigResponse, files: string[]): string {
    return createHash("sha256")
      .update(this.inventory)
      .update(this.contentFingerprint(config, files))
      .digest("hex");
  }

  checkFingerprint(config: ConfigResponse, scope: Scope): string {
    return createHash("sha256")
      .update(
        this.contentFingerprint(
          config,
          scope.sourceCheck ? scope.files : [...config.fileNames, ...scope.globals],
        ),
      )
      .update(JSON.stringify(scope.libs))
      .update(String(scope.sourceCheck))
      .digest("hex");
  }

  emitFingerprint(config: ConfigResponse): string {
    return this.contentFingerprint(config, config.fileNames);
  }

  get(configFile: string, config: ConfigResponse): Scope {
    const previous = this.cache[configFile];
    if (previous && previous.fingerprint === this.graphFingerprint(config, previous.files))
      return previous;
    const snapshot = this.api.updateSnapshot({ openProjects: [configFile] });
    try {
      const project = snapshot.getProject(configFile);
      if (!project) throw new Error(`TypeScript did not load ${configFile}`);
      const files = [...project.program.getSourceFileNames()];
      const globals: string[] = [];
      const libs = new Set<string>();
      let sourceCheck = false;
      for (const file of files) {
        const shapeKey = JSON.stringify([
          file,
          config.options.moduleDetection,
          config.options.module,
          config.options.jsx,
        ]);
        const source = project.program.getSourceFile(file);
        if (!source) throw new Error(`TypeScript did not load ${file}`);
        if (!sourceCheck)
          sourceCheck = needsSourceCheck(project, source, this.workspaceDirectories, this.root);
        let shape = this.shapes.get(shapeKey);
        if (!shape) {
          shape = {
            global:
              !source.externalModuleIndicator ||
              source.moduleAugmentations.length > 0 ||
              source.ambientModuleNames.length > 0,
            libs: source.libReferenceDirectives.map((reference) => reference.fileName),
          };
          this.shapes.set(shapeKey, shape);
        }
        if (shape.global) globals.push(file);
        for (const lib of shape.libs) libs.add(lib);
      }
      const scope = {
        files,
        globals,
        libs: [...libs].toSorted(),
        sourceCheck,
        fingerprint: this.graphFingerprint(config, files),
      };
      this.cache[configFile] = scope;
      return scope;
    } finally {
      snapshot.dispose();
      this.api.updateSnapshot({ closeProjects: [configFile] }).dispose();
    }
  }

  serialize(): unknown {
    return this.cache;
  }
}
