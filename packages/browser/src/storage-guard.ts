import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { CallResult } from "./cdp.ts";
import { decodeEvaluationValue, serializeEvaluationValue } from "./evaluation-value.ts";

/**
 * Use my Chrome (ADR 0084, amended): unless the person allows it in Settings, an agent's
 * `evaluate` runs in an isolated world from which the page's cookies and web storage are
 * removed. It reads and changes the DOM as usual; it cannot see page script variables, and every
 * way this world has to the cookie jar or storage (in this document or a same-origin frame) throws.
 * This restricts a capability rather than asking: ace adds no approval prompts of its own.
 */
export const storageRefusal =
  "Agents can't read cookies or site storage in your own browser. The person can allow it in Settings › Computer use › Use my Chrome.";

/**
 * Runs first in the world. Every accessor is replaced by a non-configurable one that throws, so
 * the original getter is unreachable from this world. Frames reachable now are locked the same
 * way; new frames cannot be created from here (frame elements and HTML that holds them refuse).
 */
export const storageLockdown = String.raw`(() => {
  const message = ${JSON.stringify(storageRefusal)};
  const refuse = () => { throw new Error(message); };
  const frameTags = /^(iframe|frame|object|embed|frameset|portal|fencedframe)$/i;
  const framesInMarkup = /<\s*(iframe|frame|object|embed|frameset|portal|fencedframe)\b/i;
  const lock = (view, depth) => {
    const deny = (target, key) => {
      if (!target) return;
      try { Object.defineProperty(target, key, { get: refuse, set: refuse, configurable: false }); } catch {}
    };
    const wrap = (target, key, guard) => {
      if (!target) return;
      const original = target[key];
      if (typeof original !== 'function') return;
      try {
        Object.defineProperty(target, key, {
          value: function (...args) { guard(args); return original.apply(this, args); },
          configurable: false, writable: false,
        });
      } catch {}
    };
    const setter = (target, key) => {
      if (!target) return;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || !descriptor.set) return;
      try {
        Object.defineProperty(target, key, {
          get: descriptor.get,
          set(value) { if (framesInMarkup.test(String(value))) refuse(); descriptor.set.call(this, value); },
          configurable: false,
        });
      } catch {}
    };
    const children = [];
    try { for (let i = 0; i < view.frames.length; i++) children.push(view.frames[i]); } catch {}
    deny(view.Document && view.Document.prototype, 'cookie');
    for (const key of ['localStorage', 'sessionStorage', 'indexedDB', 'cookieStore', 'caches', 'open', 'frames', 'opener']) {
      deny(view, key);
      deny(view.Window && view.Window.prototype, key);
    }
    for (const key of ['getItem', 'key', 'setItem', 'removeItem', 'clear', 'length'])
      deny(view.Storage && view.Storage.prototype, key);
    for (const name of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement'])
      for (const key of ['contentWindow', 'contentDocument', 'getSVGDocument'])
        deny(view[name] && view[name].prototype, key);
    const tag = (args) => { if (frameTags.test(String(args[0]))) refuse(); };
    const tagNs = (args) => { if (frameTags.test(String(args[1]).replace(/^.*:/, ''))) refuse(); };
    const markup = (args) => { if (args.some((arg) => framesInMarkup.test(String(arg)))) refuse(); };
    const proto = (name) => view[name] && view[name].prototype;
    wrap(proto('Document'), 'createElement', tag);
    wrap(proto('Document'), 'createElementNS', tagNs);
    wrap(proto('Document'), 'write', markup);
    wrap(proto('Document'), 'writeln', markup);
    wrap(proto('Element'), 'insertAdjacentHTML', markup);
    wrap(proto('Element'), 'setHTMLUnsafe', markup);
    wrap(proto('ShadowRoot'), 'setHTMLUnsafe', markup);
    wrap(proto('Range'), 'createContextualFragment', markup);
    wrap(proto('DOMParser'), 'parseFromString', markup);
    for (const key of ['importNode', 'adoptNode']) wrap(proto('Document'), key, (args) => {
      const node = args[0];
      if (node && ((node.nodeType === 1 && frameTags.test(node.localName)) ||
        (typeof node.querySelector === 'function' && node.querySelector('iframe,frame,object,embed')))) refuse();
    });
    setter(proto('Element'), 'innerHTML');
    setter(proto('Element'), 'outerHTML');
    setter(proto('ShadowRoot'), 'innerHTML');
    if (depth < 8) for (const child of children) { try { lock(child, depth + 1); } catch {} }
  };
  lock(globalThis, 0);
  return true;
})()`;

const Tree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const World = z.object({ executionContextId: z.number() });

/** A fresh isolated world on the top document with cookies and storage removed. */
async function guardedWorld(cdp: BrowserCdp, worldName: string): Promise<number> {
  const frameId = Tree.parse(await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const contextId = World.parse(
    await cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName,
      grantUniveralAccess: false,
    }),
  ).executionContextId;
  const locked = CallResult.parse(
    await cdp.send("Runtime.evaluate", {
      expression: storageLockdown,
      contextId,
      returnByValue: true,
      silent: true,
    }),
  );
  if (locked.exceptionDetails || locked.result.value !== true)
    throw new Error("Browser evaluate could not start safely");
  return contextId;
}

/**
 * `evaluate` in the person's own browser while storage reads are not allowed. `read-only` keeps
 * its V8 side-effect check; `unrestricted` may await promises for up to ten seconds.
 */
export async function evaluateWithoutStorage(
  cdp: BrowserCdp,
  expression: string,
  mode: "read-only" | "unrestricted",
  check: () => void,
): Promise<unknown> {
  const contextId = await guardedWorld(cdp, "ace-evaluate");
  check();
  const response = CallResult.parse(
    await cdp.send(
      "Runtime.evaluate",
      mode === "read-only"
        ? {
            expression: `(${serializeEvaluationValue})((${expression}))`,
            contextId,
            throwOnSideEffect: true,
            timeout: 1000,
            returnByValue: true,
            awaitPromise: false,
          }
        : {
            expression: `(async () => { let timer; try {
              const value = await Promise.race([(0,eval)(${JSON.stringify(expression)}),
                new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('evaluate timeout')),10000)})]);
              return (${serializeEvaluationValue})(value);
            } finally { clearTimeout(timer); } })()`,
            contextId,
            timeout: 10_000,
            awaitPromise: true,
            returnByValue: true,
          },
    ),
  );
  if (response.exceptionDetails) {
    const details = z
      .object({ exception: z.object({ description: z.string() }).optional() })
      .safeParse(response.exceptionDetails);
    const description = details.success ? (details.data.exception?.description ?? "") : "";
    if (description.includes(storageRefusal)) throw new Error(storageRefusal);
    throw new Error(
      mode === "read-only"
        ? "Read-only evaluation refused side effects or failed"
        : "Browser evaluate failed or timed out",
    );
  }
  return decodeEvaluationValue(response.result.value);
}
