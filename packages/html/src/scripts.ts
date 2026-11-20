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
  "subtle-foreground",
  "card",
  "surface-2",
  "hover",
  "card-foreground",
  "border",
  "input",
  "field",
  "primary",
  "primary-foreground",
  "accent",
  "accent-foreground",
  "accent-text",
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
 * CSP source for `pageBridge`. A static page's policy admits only this script, so an authored
 * script or handler that survived stripping still cannot run. `mode.test.ts` keeps it current.
 */
export const pageBridgeHash = "'sha256-Lm50VCNjORn1sSt2ou5mfSBbuEOseqCFaK35pIzX1Z4='";

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

/**
 * The most a panel message may be, as UTF-8 bytes of its JSON text (ADR 0200 §5.2). Both bridges
 * measure it before reading anything else of a message; `@ace/protocol`'s `maxPanelMessageBytes`
 * is the same bound, kept here so this file imports nothing.
 */
export const panelMessageBytes = 16 * 1024;

/**
 * A panel message's text, if it is one within the bound: a string of at most
 * `panelMessageBytes` UTF-8 bytes. A longer string is refused on its length alone, before a byte
 * of it is read (a UTF-8 text is never shorter in bytes than in UTF-16 units); anything that
 * isn't a string, unread. `fitsScript` is the same check as the bridges run it.
 */
export function panelText(data: unknown): string | undefined {
  if (typeof data !== "string" || data.length > panelMessageBytes) return undefined;
  let bytes = 0;
  for (let at = 0; at < data.length; at++) {
    const unit = data.charCodeAt(at);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    // A surrogate pair is four bytes in two units; a lone surrogate is written as U+FFFD, three.
    else if (unit >> 10 === 0x36 && data.charCodeAt(at + 1) >> 10 === 0x37) {
      bytes += 4;
      at++;
    } else bytes += 3;
    if (bytes > panelMessageBytes) return undefined;
  }
  return data;
}

/** `panelText`, as the bridges run it. */
const fitsScript = `(data) => {
    if (typeof data !== 'string' || data.length > ${panelMessageBytes}) return undefined;
    let bytes = 0;
    for (let at = 0; at < data.length; at++) {
      const unit = data.charCodeAt(at);
      if (unit < 0x80) bytes += 1;
      else if (unit < 0x800) bytes += 2;
      else if (unit >> 10 === 0x36 && data.charCodeAt(at + 1) >> 10 === 0x37) { bytes += 4; at++; }
      else bytes += 3;
      if (bytes > ${panelMessageBytes}) return undefined;
    }
    return data;
  }`;

/**
 * A package panel's own bridge (ADR 0200 §5.2), run in its page after `pageBridge` and before any
 * authored script. It gives the page a frozen \`acePanel\`: \`act(name, value)\` sends an action, but
 * only while the person is pressing or typing in the page (transient user activation), so a page
 * can't act on its own; \`state\` and \`init\` are the last ones received. It dispatches \`ace:init\`,
 * \`ace:state\` and \`ace:theme\` with their data, answers the host's watchdog \`ping\`, and reports an
 * uncaught error or rejection as a \`fault\`. Every message out is JSON text within
 * \`panelMessageBytes\`. None of this is a boundary: the page's own script can post anything, so
 * the outer bridge and the host check every message again, and nothing a page sends ever carries
 * the person's word (only ace's own confirm outside the page does).
 */
export const panelPageBridge = `(() => {
  let state;
  let init;
  const fits = ${fitsScript};
  const post = (data) => {
    const text = fits(JSON.stringify(data));
    if (text === undefined) return false;
    parent.postMessage(text, '*');
    return true;
  };
  const deliver = (type, detail) => dispatchEvent(new CustomEvent(type, { detail }));
  const api = Object.freeze({
    act(name, value) {
      if (typeof name !== 'string' || !name) return false;
      const activation = navigator.userActivation;
      if (activation && !activation.isActive) return false;
      try {
        return post(value === undefined ? { type: 'ace.panel.action', name } : { type: 'ace.panel.action', name, value });
      } catch { return false; }
    },
    get state() { return state; },
    get init() { return init; },
  });
  Object.defineProperty(globalThis, 'acePanel', { value: api, writable: false, configurable: false });
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || typeof data !== 'object') return;
    if (data.type === 'ace.panel.init') {
      init = Object.freeze({ runtime: data.runtime, tokens: data.tokens, scheme: data.scheme, reduceMotion: data.reduceMotion, size: data.size });
      deliver('ace:init', init);
    } else if (data.type === 'ace.panel.state') {
      state = data.data;
      deliver('ace:state', state);
    } else if (data.type === 'ace.panel.theme') deliver('ace:theme', { tokens: data.tokens, scheme: data.scheme });
    else if (data.type === 'ace.panel.ping' && Number.isInteger(data.n)) post({ type: 'ace.panel.pong', n: data.n });
  });
  addEventListener('error', () => post({ type: 'ace.panel.fault' }));
  addEventListener('unhandledrejection', () => post({ type: 'ace.panel.fault' }));
})();`;

/**
 * The outer document's bridge for a panel: \`frameBridge\`'s frame, with the panel's channel. Out of
 * the page it takes only JSON text of at most \`panelMessageBytes\` UTF-8 bytes, measured before it
 * is parsed (anything else, an object included, is dropped unread), of the panel's message types;
 * an action only while the person is pressing or typing in the page, which activates this
 * document too. It relays the text itself, never a copy it made. Into the page go only \`init\`,
 * \`theme\`, \`state\` and \`ping\`, and the tokens of \`init\` and \`theme\` as the theme message
 * \`pageBridge\` applies. As the top document of a desktop \`<webview>\` it reports through its title,
 * numbered so every message is a change of title.
 */
export const panelFrameBridge = `(() => {
  const template = document.getElementById('ace-page');
  const frame = template.content.querySelector('iframe');
  document.body.append(frame);
  template.remove();
  const embedded = parent !== window;
  const fits = ${fitsScript};
  const out = new Set(['ace.panel.action', 'ace.panel.fault', 'ace.panel.pong']);
  const into = new Set(['ace.panel.init', 'ace.panel.theme', 'ace.panel.state', 'ace.panel.ping']);
  let sent = 0;
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source === frame.contentWindow && event.origin === 'null') {
      const text = fits(data);
      if (text === undefined) return;
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (!message || typeof message !== 'object' || !out.has(message.type)) return;
      const activation = navigator.userActivation;
      if (message.type === 'ace.panel.action' && activation && !activation.isActive) return;
      if (embedded) parent.postMessage(text, '*');
      else document.title = 'ace.panel:' + (++sent) + ':' + text;
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (event.source === parent && into.has(data.type)) {
      if (data.type === 'ace.panel.init' || data.type === 'ace.panel.theme') {
        if (data.scheme === 'light' || data.scheme === 'dark') document.documentElement.style.colorScheme = data.scheme;
        frame.contentWindow.postMessage({ type: 'ace.html.theme', tokens: data.tokens, scheme: data.scheme }, '*');
      }
      frame.contentWindow.postMessage(data, '*');
    }
  });
})();`;

/** The text of a message a desktop panel's outer document put in its title, within the bound. */
export function panelMessageFromTitle(title: string): string | undefined {
  const match = /^ace\.panel:\d{1,12}:/.exec(title);
  return match ? panelText(title.slice(match[0].length)) : undefined;
}

/** What a desktop `<webview>`'s outer document puts in its title to report a content height. */
export function heightFromTitle(title: string): number | undefined {
  const match = /^ace\.html\.height:(\d{1,5})$/.exec(title);
  const height = match ? Number(match[1]) : Number.NaN;
  return height >= 1 && height <= 10000 ? height : undefined;
}
