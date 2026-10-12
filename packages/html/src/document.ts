import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { validateHtml } from "./validation.ts";

/** No endpoints, storage, workers, frames, forms, eval or provider credentials. */
export const htmlCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
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
export type HtmlTheme = Partial<Record<(typeof themeProperties)[number], string>>;
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
const bridge = `(() => {
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
function themedDocument(html: string, theme: HtmlTheme): string {
  const document = parse(html);
  const root = document.childNodes.find(
    (node): node is DefaultTreeAdapterMap["element"] =>
      "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is DefaultTreeAdapterMap["element"] =>
      "tagName" in node && node.tagName === "head",
  );
  if (!head) throw new Error("HTML document has no head");
  const tokens = themeProperties
    .flatMap((key) => {
      const value = theme[key];
      return value && !/[<>{};]/.test(value) ? [`--${key}:${value}`] : [];
    })
    .join(";");
  const prefix = parseFragment(
    `<meta http-equiv="Content-Security-Policy" content="${attribute(htmlCsp)}"><meta name="referrer" content="no-referrer"><style>:root{${tokens}}html{color:var(--foreground);font-family:var(--font-sans,system-ui);background:transparent}body{margin:0;display:flow-root}*{box-sizing:border-box}</style><script>${bridge}</script>`,
  );
  head.childNodes.unshift(...prefix.childNodes);
  return serialize(document);
}
/**
 * A trusted outer document owns frame-src, so even script-driven child navigation is blocked.
 * Each frame has a separate opaque origin. Only height crosses either boundary.
 */
export function visualizationDocument(html: string, theme: HtmlTheme): string {
  if (!validateHtml(html).valid) throw new Error("Invalid visualization document");
  const page = themedDocument(html, theme);
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${attribute(htmlCsp)}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0}iframe{width:100%;border:0;display:block}</style></head><body><iframe title="Visualization content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(page)}"></iframe><script>(()=>{const frame=document.querySelector('iframe');addEventListener('message',event=>{const data=event.data;if(event.source!==frame.contentWindow||event.origin!=='null'||!data||Object.keys(data).length!==2||data.type!=='ace.html.height'||typeof data.height!=='number'||!Number.isFinite(data.height)||data.height<1||data.height>10000)return;frame.style.height=data.height+'px';parent.postMessage({type:'ace.html.height',height:data.height},'*');});})();</script></body></html>`;
}
/** A data URL starts with an opaque origin and does not inherit the app's script CSP. */
export function visualizationUrl(html: string, theme: HtmlTheme): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(visualizationDocument(html, theme))}`;
}
/** Opening keeps the same sandbox; never open authored HTML as an app-origin blob. */
export function visualizationWindow(html: string, theme: HtmlTheme): string {
  const policy = htmlCsp.replace("frame-src 'none'", "frame-src data:");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><title>ace visualization</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body><iframe title="Visualization" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${attribute(visualizationUrl(html, theme))}"></iframe></body></html>`;
}
