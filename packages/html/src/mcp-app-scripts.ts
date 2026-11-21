import { fitsScript } from "./scripts.ts";

/*
 * The bridges of an MCP app's page shown as a panel (ADR 0202 §4), in the same sandbox as a
 * package's panel (ADR 0200 §5.2): the trusted outer document, the opaque-origin
 * `sandbox="allow-scripts"` frame and its `default-src 'none'` policy. Neither is a boundary on
 * its own; the host reads every message again.
 */

/**
 * Run in the page before any of its own script. MCP Apps' transport posts JSON-RPC objects to
 * `window.parent`; here `parent` is a stand-in (a message port of the page's own, never a window,
 * whose fresh realm would hand back unguarded constructors) whose `postMessage` writes each
 * message as JSON text itself and holds it to the panel bound
 * (`panelMessageBytes` of UTF-8) before it leaves, so only bounded text crosses to the outer
 * document (as a package panel's messages do). A request over the bound is answered here with an
 * error. What the outer document sends reaches the page as from the stand-in, so a transport
 * that checks its messages' source still hears it. The bridge also answers the host's watchdog
 * ping and reports an uncaught error, as panel text. None of this is a boundary: the outer
 * document reads every message again, text only.
 */
export const mcpAppPageBridge = `(() => {
  const fits = ${fitsScript};
  const stringify = JSON.stringify;
  const host = parent;
  const post = (data) => { const text = fits(stringify(data)); if (text !== undefined) host.postMessage(text, '*'); };
  const standIn = new MessageChannel().port1;
  const answer = (data) => dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: standIn }));
  const send = (message) => {
    let text;
    try { text = typeof message === 'string' ? message : stringify(message); } catch { return; }
    if (typeof text !== 'string') return;
    if (fits(text) === undefined) {
      const request = message && typeof message === 'object' && typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number');
      if (request) answer({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'The message is larger than 16 KiB.' } });
      return;
    }
    host.postMessage(text, '*');
  };
  Object.defineProperty(standIn, 'postMessage', { value: (message) => send(message), writable: false, configurable: false });
  Object.defineProperty(window, 'parent', { value: standIn, writable: false, configurable: false });
  addEventListener('message', (event) => {
    if (event.source !== host) return;
    event.stopImmediatePropagation();
    const data = event.data;
    if (data && typeof data === 'object' && data.type === 'ace.panel.ping') {
      if (Number.isInteger(data.n)) post({ type: 'ace.panel.pong', n: data.n });
      return;
    }
    answer(data);
  }, true);
  addEventListener('error', () => post({ type: 'ace.panel.fault' }));
  addEventListener('unhandledrejection', () => post({ type: 'ace.panel.fault' }));
})();`;

/**
 * The outer document's bridge for an MCP app's page. From the page it takes text only, as a
 * package panel's outer document does: a string is held to the panel bound on its length before a
 * byte of it is read, and parsed only then; anything else (an object the page posted past the
 * page bridge's stand-in) is dropped unread by any stringify. What passes must be JSON-RPC 2.0 or
 * the page bridge's pong or fault. A page's `tools/call`, `ui/message` and `ui/open-link` go only
 * while the person is pressing or typing in the page; otherwise the page is answered with an
 * error here. Into the page go only JSON-RPC, the watchdog's ping and the theme. As the top
 * document of a desktop `<webview>` it reports through its title, numbered, as a package panel's
 * does.
 */
export const mcpAppFrameBridge = `(() => {
  const template = document.getElementById('ace-page');
  const frame = template.content.querySelector('iframe');
  document.body.append(frame);
  template.remove();
  const embedded = parent !== window;
  const fits = ${fitsScript};
  const own = new Set(['ace.panel.fault', 'ace.panel.pong']);
  const pressed = new Set(['tools/call', 'ui/message', 'ui/open-link']);
  let sent = 0;
  const relay = (text) => {
    if (embedded) parent.postMessage(text, '*');
    else document.title = 'ace.panel:' + (++sent) + ':' + text;
  };
  const refuse = (id, message) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } }, '*');
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source === frame.contentWindow && event.origin === 'null') {
      const text = fits(data);
      if (text === undefined) return;
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (own.has(message.type)) { relay(text); return; }
      if (message.jsonrpc !== '2.0') return;
      const request = typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number');
      const activation = navigator.userActivation;
      if (typeof message.method === 'string' && pressed.has(message.method) && activation && !activation.isActive) {
        if (request) refuse(message.id, 'A page sends this only while the person is using it.');
        return;
      }
      relay(text);
      return;
    }
    if (event.source !== parent || !data || typeof data !== 'object') return;
    if (data.type === 'ace.html.theme' || data.type === 'ace.panel.theme') {
      if (data.scheme === 'light' || data.scheme === 'dark') document.documentElement.style.colorScheme = data.scheme;
      frame.contentWindow.postMessage({ type: 'ace.html.theme', tokens: data.tokens, scheme: data.scheme }, '*');
    } else if (data.type === 'ace.panel.ping' || data.jsonrpc === '2.0') frame.contentWindow.postMessage(data, '*');
  });
})();`;
