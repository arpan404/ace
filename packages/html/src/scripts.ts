/**
 * The only inline scripts a visualization document runs. Both are fixed text, so an embedding
 * app can allow them by hash: data and srcdoc frames inherit the embedder's CSP in Chromium,
 * and an app whose `script-src` lacks these hashes renders every visualization blank.
 * No parse5 import here, so the desktop main bundle can read them cheaply.
 */

/** Runs in the authored page: removes WebRTC and reports the content height. */
export const pageBridge = `(() => {
  // WebRTC is not covered by connect-src. Keep its constructors unavailable in the static document.
  for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection'])
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
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

/** Runs in the trusted outer frame: attaches the page frame and relays only its height. */
export const frameBridge =
  "(()=>{const template=document.getElementById('ace-page');const frame=template.content.querySelector('iframe');document.body.append(frame);template.remove();addEventListener('message',event=>{const data=event.data;if(event.source!==frame.contentWindow||event.origin!=='null'||!data||Object.keys(data).length!==2||data.type!=='ace.html.height'||typeof data.height!=='number'||!Number.isFinite(data.height)||data.height<1||data.height>10000)return;frame.style.height=data.height+'px';parent.postMessage({type:'ace.html.height',height:data.height},'*');});})();";

export const visualizationScripts = [frameBridge, pageBridge] as const;
