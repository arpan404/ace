import type { Plugin, Rolldown } from "vite";

/**
 * Start the first screen's code with the page, not after the code that asks for it has run
 * (ADR 0056).
 *
 * The built page names only the entry script, a few kilobytes that then import the initial
 * chunk; the router asks for the open route's chunks only once the initial chunk has run and the
 * app has rendered, and each of those chunks names more. On a link with a long round trip every
 * step of that chain is a round trip of nothing arriving. This plugin writes into the page:
 *
 * - a `modulepreload` for each chunk of the entry's static closure, so the initial chunk downloads
 *   alongside the entry instead of after it;
 * - a small inline script that, for the address being loaded, adds a `modulepreload` (and a
 *   stylesheet preload) for every chunk the matching route's components load, so they download
 *   while the initial chunk does. The router's own requests for them then find them in flight.
 *   They go at low priority: over HTTP/1.1 a browser opens six connections to a host, and the
 *   route's many small chunks would otherwise hold the initial chunk and the client worker's
 *   script in that queue.
 *
 * Each route is a pattern over `location.pathname` and the modules (route component ids, with
 * TanStack's `?tsr-split=component`) whose chunks it loads first. The inline script is hashed
 * into the page's Content Security Policy like the others (`content-policy.ts`, which must run
 * after this plugin).
 */
export interface RoutePreload {
  /** A regular expression source matched against `location.pathname`. */
  path: string;
  /** Module ids whose chunks, with their static imports and CSS, the route loads first. */
  modules: string[];
}

/** The parts of an output chunk the hints read. */
export interface HintChunk {
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  css: string[];
}

export interface PageHints {
  /** The entry's static closure, minus the entry itself. */
  initial: string[];
  /** Per route, its first chunks and their CSS, minus what the initial closure has. */
  routes: { path: string; files: string[] }[];
}

/** What to hint, from the bundle's chunks. Files are bundle file names (`assets/x.js`). */
export function pageHints(
  chunks: readonly HintChunk[],
  routes: readonly RoutePreload[],
): PageHints {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const closure = (roots: readonly HintChunk[], skip: ReadonlySet<string>) => {
    const files: string[] = [];
    const seen = new Set<string>();
    const visit = (chunk: HintChunk) => {
      if (seen.has(chunk.fileName) || skip.has(chunk.fileName)) return;
      seen.add(chunk.fileName);
      files.push(chunk.fileName);
      for (const css of chunk.css)
        if (!seen.has(css) && !skip.has(css)) {
          seen.add(css);
          files.push(css);
        }
      for (const imported of chunk.imports) {
        const next = byFile.get(imported);
        if (next) visit(next);
      }
    };
    for (const root of roots) visit(root);
    return files;
  };
  const entries = chunks.filter((chunk) => chunk.isEntry);
  const loaded = new Set(closure(entries, new Set()));
  const initial = closure(entries, new Set()).filter(
    (file) => file.endsWith(".js") && !entries.some((entry) => entry.fileName === file),
  );
  return {
    initial,
    routes: routes.flatMap((route) => {
      const roots = route.modules.flatMap((id) =>
        chunks.filter((chunk) => chunk.facadeModuleId === id),
      );
      const files = closure(roots, loaded);
      return files.length ? [{ path: route.path, files }] : [];
    }),
  };
}

/**
 * The inline script: for the first route whose pattern matches `path`, a preload link per file.
 * `base` is the build's public base (`/`). Written as `(function (path, head) {...})` applied to
 * the page's address and head, so a test can run it against its own.
 */
export function hintScript(routes: PageHints["routes"], base: string): string {
  // Script names are stored without their extension, to keep the page small.
  const table = routes.map((route) => [
    route.path,
    route.files.map((file) => (file.endsWith(".css") ? file : file.replace(/\.js$/, ""))),
  ]);
  return `(function (path, head) {
  var routes = ${JSON.stringify(table)};
  for (var i = 0; i < routes.length; i++) {
    if (!new RegExp(routes[i][0]).test(path)) continue;
    var files = routes[i][1];
    for (var j = 0; j < files.length; j++) {
      var link = document.createElement("link");
      var css = /\\.css$/.test(files[j]);
      link.rel = css ? "preload" : "modulepreload";
      if (css) link.setAttribute("as", "style");
      link.crossOrigin = "";
      // After the initial chunk and the client worker, which the first screen also waits on.
      link.setAttribute("fetchpriority", "low");
      link.href = ${JSON.stringify(base)} + files[j] + (css ? "" : ".js");
      head.appendChild(link);
    }
    return;
  }
})(location.pathname, document.head);`;
}

/**
 * The page with its hints ahead of the entry script and the stylesheet the build puts after it:
 * an inline script waits for every stylesheet before it to load, so behind one it would start
 * the route's chunks only once the CSS had arrived.
 */
export function withHints(html: string, hints: PageHints, base: string): string {
  const tags = [
    ...hints.initial.map((file) => `<link rel="modulepreload" crossorigin href="${base}${file}">`),
    ...(hints.routes.length ? [`<script>${hintScript(hints.routes, base)}</script>`] : []),
  ].join("\n");
  if (!tags) return html;
  const at = html.search(/<script type="module"|<link rel="stylesheet"|<\/head>/);
  return at < 0 ? html : `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}

function hintChunks(bundle: Rolldown.OutputBundle): HintChunk[] {
  return Object.values(bundle).flatMap((output) =>
    output.type === "chunk"
      ? [
          {
            fileName: output.fileName,
            isEntry: output.isEntry,
            facadeModuleId: output.facadeModuleId,
            imports: output.imports,
            css: [...(output.viteMetadata?.importedCss ?? [])],
          },
        ]
      : [],
  );
}

export function routePreloads(routes: readonly RoutePreload[]): Plugin {
  let base = "/";
  return {
    name: "ace:route-preloads",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.bundle) return html;
        return withHints(html, pageHints(hintChunks(context.bundle), routes), base);
      },
    },
  };
}
