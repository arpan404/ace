/**
 * The fixed scripts and names a visualization document runs with. No parse5 import here, so the
 * desktop main bundle can read the partition name cheaply.
 */

/**
 * The in-memory Electron session that holds every visualization. Its network layer cancels
 * every request that is not the page's own `data:` or `blob:` document (apps/desktop).
 */
export const visualizationPartition = "ace-visualization";

/** CSS custom properties a page receives, and receives again whenever the app theme changes. */
export const themeProperties = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "card",
  "card-foreground",
  "border",
  "primary",
  "primary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "success",
  "warning",
  "info",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "radius",
  "font-sans",
  "font-mono",
] as const;

/** Elements whose markup or creation can start a request that CSP does not govern. */
export const blockedElements = [
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "fencedframe",
  "meta",
  "base",
] as const;

/**
 * Runs in the authored page before any authored script.
 * - Removes WebRTC, which `connect-src` does not cover.
 * - Refuses to create `<link>` (network hints skip CSP in Blink) and frames (a fresh realm
 *   would hand back unguarded constructors), and routes every HTML string sink through a
 *   Trusted Types default policy that drops those elements.
 * - Applies live theme messages from the trusted outer frame and reports content height.
 * In the desktop app the visualization session's network layer is the boundary; this guard is
 * what the web client has.
 */
export const pageBridge = `(() => {
  const lock = (owner, name, value) => Object.defineProperty(owner, name, { value, writable: false, configurable: false });
  for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','XSLTProcessor'])
    lock(globalThis, name, undefined);
  const blocked = new Set(${JSON.stringify(blockedElements)});
  const refuse = () => { throw new DOMException('Not available in ace visualizations', 'NotSupportedError'); };
  const local = (name) => String(name).split(':').pop().toLowerCase();
  const create = Document.prototype.createElement;
  const createNS = Document.prototype.createElementNS;
  lock(Document.prototype, 'createElement', function (name, options) {
    if (blocked.has(local(name))) refuse();
    return create.call(this, name, options);
  });
  lock(Document.prototype, 'createElementNS', function (namespace, name, options) {
    if (namespace === 'http://www.w3.org/1999/xhtml' && blocked.has(local(name))) refuse();
    return createNS.call(this, namespace, name, options);
  });
  const define = CustomElementRegistry.prototype.define;
  lock(CustomElementRegistry.prototype, 'define', function (name, constructor, options) {
    const extended = options && options.extends;
    if (extended !== undefined && blocked.has(local(extended))) refuse();
    return define.call(this, name, constructor, extended === undefined ? undefined : { extends: String(extended) });
  });
  for (const [owner, name] of [[Element.prototype, 'setHTML'], [ShadowRoot.prototype, 'setHTML'], [Document, 'parseHTML']])
    if (name in owner) lock(owner, name, undefined);
  if (globalThis.trustedTypes) {
    const raw = trustedTypes.createPolicy('ace-raw', { createHTML: (value) => value });
    const strip = (fragment) => {
      for (const node of fragment.querySelectorAll('*')) {
        if (blocked.has(node.localName) && node.namespaceURI === 'http://www.w3.org/1999/xhtml') node.remove();
        else if (node.localName === 'template') strip(node.content);
      }
    };
    trustedTypes.createPolicy('default', {
      createHTML(value) {
        const template = create.call(document, 'template');
        template.innerHTML = raw.createHTML(String(value));
        strip(template.content);
        return template.innerHTML;
      },
      createScript: (value) => value,
    });
  }
  const tokens = new Set(${JSON.stringify(themeProperties)});
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== 'ace.html.theme' || typeof data.tokens !== 'object' || !data.tokens) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(data.tokens))
      if (tokens.has(name) && typeof value === 'string' && !/[<>{};]/.test(value)) root.style.setProperty('--' + name, value);
    if (data.scheme === 'light' || data.scheme === 'dark') root.style.colorScheme = data.scheme;
    dispatchEvent(new Event('ace:theme'));
  });
  let queued = false;
  const report = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const height = Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height));
      parent.postMessage({type:'ace.html.height',height:Math.min(10000,Math.max(1,height))}, '*');
    });
  };
  addEventListener('DOMContentLoaded', () => { new ResizeObserver(report).observe(document.body); report(); });
  addEventListener('load', report);
})();`;

/**
 * Runs in the trusted outer document. Attaches the page frame, relays only its height out, and
 * relays only theme messages in. Inside an iframe it talks to the app by `postMessage`; as the
 * top document of a desktop `<webview>` (which has no preload) it reports height through its
 * title, which the authored page cannot set.
 */
export const frameBridge = `(() => {
  const template = document.getElementById('ace-page');
  const frame = template.content.querySelector('iframe');
  document.body.append(frame);
  template.remove();
  const embedded = parent !== window;
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (event.source === frame.contentWindow && event.origin === 'null') {
      if (Object.keys(data).length !== 2 || data.type !== 'ace.html.height' || typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height < 1 || data.height > 10000) return;
      frame.style.height = data.height + 'px';
      if (embedded) parent.postMessage({ type: 'ace.html.height', height: data.height }, '*');
      else document.title = 'ace.html.height:' + Math.ceil(data.height);
      return;
    }
    if (event.source === parent && data.type === 'ace.html.theme') {
      if (data.scheme === 'light' || data.scheme === 'dark') document.documentElement.style.colorScheme = data.scheme;
      frame.contentWindow.postMessage({ type: 'ace.html.theme', tokens: data.tokens, scheme: data.scheme }, '*');
    }
  });
})();`;

/** What a desktop `<webview>`'s outer document puts in its title to report a content height. */
export function heightFromTitle(title: string): number | undefined {
  const match = /^ace\.html\.height:(\d{1,5})$/.exec(title);
  const height = match ? Number(match[1]) : Number.NaN;
  return height >= 1 && height <= 10000 ? height : undefined;
}
