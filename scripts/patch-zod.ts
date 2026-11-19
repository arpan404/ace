import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Applies ace's changes to a pristine Zod 4 package directory, in place. They are what
 * `patches/zod@<version>.patch` holds; on a Zod upgrade, run `bun patch zod@<new>`, then
 * `bun scripts/patch-zod.ts node_modules/zod` and `bun patch --commit node_modules/zod`.
 * Every edit asserts its anchor text, so a Zod release that moved the code fails here instead
 * of patching the wrong place.
 *
 * What the changes do (ESM and CJS alike), none of which changes what a schema accepts,
 * returns or prints:
 * 1. Lazy schemas. The first instance of each constructor is built at once, which installs the
 *    constructor's members on its prototype; later instances keep only their def until
 *    something reads `_zod` or a property Zod's initializers put on instances. `def` and
 *    `type` are served from the kept def, and `clone` copies a shell without building it, so
 *    chains like `z.string().min(1).max(9)` leave shells behind. `toJSON` builds first, so
 *    `JSON.stringify` of a schema is unchanged. `z.config({ eagerSchemas: true })` turns it off.
 * 2. One traits set per distinct trait list, instead of one per schema (copied on write).
 * 3. One JSON Schema processor reference per type, instead of a closure per schema.
 */
const root = process.argv[2];
if (!root) throw new Error("usage: bun scripts/patch-zod.ts <zod package directory>");

function edit(file: string, change: (source: string) => string) {
  const path = join(root, "v4", file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
}
function replaceOnce(source: string, anchor: string, replacement: string): string {
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + 1) >= 0)
    throw new Error(`anchor not found exactly once: ${anchor.slice(0, 80)}`);
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

const coreHeader = `// ace patch: one traits set per distinct trait list, and lazy schemas (see $constructor).
const sharedTraits = new Map();
const lazyDef = Symbol.for("ace.zod.lazyDef");
const lazyParent = Symbol.for("ace.zod.lazyParent");
// Types whose setup rejects an invalid definition; they are built at once so it still throws there.
const eagerConstructors = new Set(["UUID", "NanoID", "TemplateLiteral", "DiscriminatedUnion"]);
// Properties Zod's initializers put directly on instances; reading one builds a shell.
const lazyInstanceKeys = ["def", "type", "shape", "options", "element", "unwrap", "min", "max", "valueType", "keyType", "size", "nonempty", "values", "value", "enum", "removeDefault", "removeCatch", "in", "out", "mime", "isFinite", "extract", "exclude", "implement", "implementAsync", "input", "output"];
`;

const constructorTail = `        // ace patch: instances whose traits match share one set, instead of one set per schema.
        {
            const traits = inst._zod.traits;
            let key = "";
            for (const trait of traits)
                key += trait + "\\0";
            const shared = sharedTraits.get(key);
            if (shared === undefined) {
                traits.__shared = true;
                sharedTraits.set(key, traits);
            }
            else if (shared !== traits)
                inst._zod.traits = shared;
        }
        // Global post-processor hook.`;

const lazyConstructor = `    // ace patch: lazy schemas. The first instance of each constructor is built at once, which
    // installs the constructor's members on its prototype. Later instances only keep their def
    // until something reads \`_zod\` or one of the properties initializers put on instances; then
    // the instance is built exactly as it would have been. Schemas nothing touches stay a shell.
    let armed = false;
    const eager = eagerConstructors.has(name.replace("$", "").replace("Zod", ""));
    function arm() {
        armed = true;
        const proto = _.prototype;
        Object.defineProperty(proto, "_zod", {
            configurable: true,
            enumerable: false,
            get() {
                const pending = this[lazyDef];
                if (pending === undefined)
                    return undefined;
                this[lazyDef] = undefined;
                build(this, pending);
                const parent = this[lazyParent];
                if (parent !== undefined) {
                    this[lazyParent] = undefined;
                    this._zod.parent = parent;
                }
                return this._zod;
            },
        });
        // JSON.stringify of a schema writes its own enumerable properties, which a shell has none
        // of yet; build it first so the output is the same as for an eagerly built schema.
        if (!Object.prototype.hasOwnProperty.call(proto, "toJSON")) {
            Object.defineProperty(proto, "toJSON", {
                configurable: true,
                enumerable: false,
                writable: true,
                value() {
                    void this._zod;
                    return { ...this };
                },
            });
        }
        for (const key of lazyInstanceKeys) {
            if (Object.prototype.hasOwnProperty.call(proto, key))
                continue;
            // The def a shell keeps is the one its build assigns to \`def\`, so reading it (or its
            // type) needs no build.
            const fromDef = key === "def" ? (d) => d : key === "type" ? (d) => d.type : undefined;
            Object.defineProperty(proto, key, {
                configurable: true,
                enumerable: false,
                get() {
                    const pending = this[lazyDef];
                    if (pending !== undefined) {
                        if (fromDef)
                            return fromDef(pending);
                        void this._zod;
                    }
                    return Object.prototype.hasOwnProperty.call(this, key) ? this[key] : undefined;
                },
                set(value) {
                    Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
                },
            });
        }
    }
    function _(def) {
        if (params?.Parent)
            return build(newError(Definition), def);
        const inst = this;
        // Subclass instances are always built: a shell's prototype must name its constructor.
        if (!armed || eager || globalThis.__zod_globalConfig?.eagerSchemas || Object.getPrototypeOf(inst) !== _.prototype) {
            build(inst, def);
            if (!armed)
                arm();
            return inst;
        }
        Object.defineProperty(inst, lazyDef, { value: def, writable: true, enumerable: false, configurable: true });
        return inst;
    }
`;

for (const ext of ["js", "cjs"]) {
  edit(`core/core.${ext}`, (source) => {
    let s = source;
    const at = s.indexOf("function $constructor(");
    const line = s.lastIndexOf("\n", at) + 1;
    s = s.slice(0, line) + coreHeader + s.slice(line);
    s = replaceOnce(
      s,
      `        inst._zod.traits.add(name);
        initializer(inst, def);`,
      `        // ace patch: a shared traits set is copied before it changes.
        if (inst._zod.traits.__shared)
            inst._zod.traits = new Set(inst._zod.traits);
        inst._zod.traits.add(name);
        initializer(inst, def);`,
    );
    s = replaceOnce(
      s,
      `    function _(def) {
        const inst = params?.Parent ? newError(Definition) : this;
        init(inst, def);`,
      `    function build(inst, def) {
        init(inst, def);`,
    );
    s = replaceOnce(s, "        // Global post-processor hook.", constructorTail);
    s = replaceOnce(
      s,
      `    Object.defineProperty(_, "init", { value: init });`,
      lazyConstructor + `    Object.defineProperty(_, "init", { value: init });`,
    );
    return s;
  });
  edit(`core/util.${ext}`, (s) =>
    replaceOnce(
      s,
      `    const cl = new inst._zod.constr(def ?? inst._zod.def);
    if (!def || params?.parent)
        cl._zod.parent = inst;
    return cl;`,
      `    // ace patch: clone a lazy schema without building it. A shell's prototype is its
    // constructor's own (subclass instances are never shells), so it names the constructor.
    const pending = inst[Symbol.for("ace.zod.lazyDef")];
    const cl = pending !== undefined
        ? new (Object.getPrototypeOf(inst).constructor)(def ?? pending)
        : new inst._zod.constr(def ?? inst._zod.def);
    if (!def || params?.parent) {
        // A lazy clone keeps its parent until it is built.
        if (cl[Symbol.for("ace.zod.lazyDef")] !== undefined)
            cl[Symbol.for("ace.zod.lazyParent")] = inst;
        else
            cl._zod.parent = inst;
    }
    return cl;`,
    ),
  );
  edit(`core/schemas.${ext}`, (s) =>
    replaceOnce(
      s,
      `        const propShape = util.rawShape(option._zod.def);`,
      `        // ace patch: read a lazy option's def without building it.
        const propShape = util.rawShape(option[Symbol.for("ace.zod.lazyDef")] ?? option._zod.def);`,
    ),
  );
  edit(`core/to-json-schema.${ext}`, (s) =>
    replaceOnce(
      s,
      `        if (schema._zod.processJSONSchema) {
            schema._zod.processJSONSchema(ctx, result.schema, params);
        }`,
      `        if (schema._zod.processJSONSchema) {
            schema._zod.processJSONSchema(ctx, result.schema, params);
        }
        // ace patch: a processor shared by every schema of the type, instead of a closure per schema.
        else if (schema._zod.jsonProcessor) {
            schema._zod.jsonProcessor(schema, ctx, result.schema, params);
        }`,
    ),
  );
  edit(`classic/schemas.${ext}`, (s) => {
    const pattern =
      /inst\._zod\.processJSONSchema = \(ctx, json, params\) => (processors\.\w+)\(inst, ctx, json, params\);/g;
    const count = s.match(pattern)?.length ?? 0;
    if (count !== 41)
      throw new Error(`expected 41 JSON Schema closures in classic/schemas.${ext}, found ${count}`);
    return s.replace(pattern, "inst._zod.jsonProcessor = $1;");
  });
}
console.log(`patched ${root}`);
