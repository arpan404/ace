import { fitsScript } from "./scripts.ts";

/*
 * The bridges of an MCP app's page shown as a panel (ADR 0202 §4), in the same sandbox as a
 * package's panel (ADR 0200 §5.2): the trusted outer document, the opaque-origin
 * `sandbox="allow-scripts"` frame and its `default-src 'none'` policy. Neither is a boundary on
 * its own; the host reads every message again.
 */

/**
 * Run in the page before any of its own script: it answers the host's watchdog ping and reports
 * an uncaught error, as panel text. The page's own JSON-RPC (MCP Apps' transport) goes to its
 * parent untouched.
 */
export const mcpAppPageBridge = `(() => {
  const fits = ${fitsScript};
  const post = (data) => { const text = fits(JSON.stringify(data)); if (text !== undefined) parent.postMessage(text, '*'); };
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || typeof data !== 'object') return;
    if (data.type === 'ace.panel.ping' && Number.isInteger(data.n)) post({ type: 'ace.panel.pong', n: data.n });
  });
  addEventListener('error', () => post({ type: 'ace.panel.fault' }));
  addEventListener('unhandledrejection', () => post({ type: 'ace.panel.fault' }));
})();`;

/**
 * The outer document's bridge for an MCP app's page. MCP Apps' transport posts JSON-RPC objects,
 * so this document writes each as JSON text itself and holds the text to the panel bound
 * (`panelMessageBytes` of UTF-8) before relaying it; anything that isn't JSON-RPC 2.0 is
 * dropped, and of plain text only the page bridge's pong and fault pass. A page's `tools/call`,
 * `ui/message` and `ui/open-link` go only while the person is pressing or typing in the page;
 * otherwise, as for a message over the bound, the page is answered with an error here. Into the
 * page go only JSON-RPC, the watchdog's ping and the theme. As the top document of a desktop
 * `<webview>` it reports through its title, numbered, as a package panel's does.
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
      if (typeof data === 'string') {
        const text = fits(data);
        if (text === undefined) return;
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (message && typeof message === 'object' && own.has(message.type)) relay(text);
        return;
      }
      if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
      const request = typeof data.method === 'string' && (typeof data.id === 'string' || typeof data.id === 'number');
      let text;
      try { text = fits(JSON.stringify(data)); } catch { return; }
      if (text === undefined) {
        if (request) refuse(data.id, 'The message is larger than 16 KiB.');
        return;
      }
      const activation = navigator.userActivation;
      if (typeof data.method === 'string' && pressed.has(data.method) && activation && !activation.isActive) {
        if (request) refuse(data.id, 'A page sends this only while the person is using it.');
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
