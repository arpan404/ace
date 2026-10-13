// oxlint-disable import/no-unassigned-import -- Each grammar registers itself on Prism.
// Imported only after the host disables Prism's automatic DOM/worker handlers.
import Prism from "prismjs/components/prism-core.js";
export { Prism };

/*
 * Each grammar is its own chunk, loaded the first time a fence in its language is highlighted,
 * after the grammars it extends (they register on Prism in dependency order).
 */
const once = (load: () => Promise<unknown>) => {
  let loading: Promise<unknown> | undefined;
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
};
const markup = once(() => import("prismjs/components/prism-markup.js"));
const clike = once(() => import("prismjs/components/prism-clike.js"));
const javascript = once(async () => {
  await clike();
  await import("prismjs/components/prism-javascript.js");
});
const typescript = once(async () => {
  await javascript();
  await import("prismjs/components/prism-typescript.js");
});
const jsx = once(async () => {
  await Promise.all([markup(), javascript()]);
  await import("prismjs/components/prism-jsx.js");
});
const json = once(() => import("prismjs/components/prism-json.js"));
const c = once(async () => {
  await clike();
  await import("prismjs/components/prism-c.js");
});
const onClike = (load: () => Promise<unknown>) =>
  once(async () => {
    await clike();
    await load();
  });

/** Grammar loaders by Prism language name. */
export const grammars: Readonly<Record<string, () => Promise<unknown>>> = {
  markup,
  css: once(() => import("prismjs/components/prism-css.js")),
  clike,
  javascript,
  typescript,
  jsx,
  tsx: once(async () => {
    await Promise.all([jsx(), typescript()]);
    await import("prismjs/components/prism-tsx.js");
  }),
  json,
  json5: once(async () => {
    await json();
    await import("prismjs/components/prism-json5.js");
  }),
  python: once(() => import("prismjs/components/prism-python.js")),
  bash: once(() => import("prismjs/components/prism-bash.js")),
  rust: once(() => import("prismjs/components/prism-rust.js")),
  go: onClike(() => import("prismjs/components/prism-go.js")),
  java: onClike(() => import("prismjs/components/prism-java.js")),
  kotlin: onClike(() => import("prismjs/components/prism-kotlin.js")),
  swift: once(() => import("prismjs/components/prism-swift.js")),
  c,
  cpp: once(async () => {
    await c();
    await import("prismjs/components/prism-cpp.js");
  }),
  csharp: onClike(() => import("prismjs/components/prism-csharp.js")),
  yaml: once(() => import("prismjs/components/prism-yaml.js")),
  markdown: once(async () => {
    await markup();
    await import("prismjs/components/prism-markdown.js");
  }),
  sql: once(() => import("prismjs/components/prism-sql.js")),
};
