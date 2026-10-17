import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

/*
 * A tab's live identity: the document's own title (kept in step with `document.title`, so SPA
 * titles and unread counts follow) and its favicon, as a small PNG data URL. It works the same in
 * every engine (ace's Chrome, the desktop's native view, the person's own Chrome) because it is
 * plain CDP on the tab's own page: a script in an isolated world watches the document head and
 * reports through a binding only that world can call. The page's own scripts can neither see the
 * world nor speak for it.
 *
 * The icon is rasterised in the page itself, from the page's own cache and cookies, so ace never
 * fetches a site's icon on its own. A cross-origin icon without CORS taints the canvas and is
 * left out (the tab shows the globe), as is an icon the page's CSP keeps from loading.
 */

export const identityWorld = "ace-identity";
export const identityBinding = "__aceIdentity";
/** The wire bound on a tab's favicon (`BrowserTab.favicon`). */
export const faviconLimit = 8192;
const titleLimit = 1024;

/**
 * Runs once per document in the `ace-identity` world. Reports `{title, icon}` 100 ms after the
 * head settles, the title at once and the icon once it is drawn (32px, else 16px, else none).
 */
const source = `(() => {
  if (globalThis.__aceIdentityOn) return;
  globalThis.__aceIdentityOn = true;
  const send = globalThis[${JSON.stringify(identityBinding)}];
  if (typeof send !== "function") return;
  const limit = ${faviconLimit};
  let last = "", timer = 0, iconFor, icon = "", turn = 0;
  const web = () => location.protocol === "http:" || location.protocol === "https:";
  const declared = () => {
    const links = [...document.querySelectorAll("link[rel][href]")].filter((link) =>
      /(^|\\s)icon(\\s|$)/i.test(link.rel) || /apple-touch-icon/i.test(link.rel));
    const plain = links.filter((link) => !/apple-touch-icon/i.test(link.rel));
    const size = (link) => {
      const match = /(\\d+)x\\d+/.exec(link.getAttribute("sizes") || "");
      return match ? Math.abs(Number(match[1]) - 32) : 16;
    };
    const best = (plain.length ? plain : links).sort((a, b) => size(a) - size(b))[0];
    if (best && best.href) return best.href;
    return web() ? new URL("/favicon.ico", location.href).href : "";
  };
  const draw = (url) => new Promise((resolve) => {
    if (!url) return resolve("");
    const image = new Image();
    try {
      if (!url.startsWith("data:") && new URL(url).origin !== location.origin) image.crossOrigin = "anonymous";
    } catch { return resolve(""); }
    image.onload = () => {
      try {
        const width = image.naturalWidth || 32, height = image.naturalHeight || 32;
        for (const side of [32, 16]) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = side;
          const scale = side / Math.max(width, height);
          const w = width * scale, h = height * scale;
          canvas.getContext("2d").drawImage(image, (side - w) / 2, (side - h) / 2, w, h);
          const data = canvas.toDataURL("image/png");
          if (data.length <= limit) return resolve(data);
        }
      } catch {}
      resolve("");
    };
    image.onerror = () => resolve("");
    image.src = url;
  });
  const post = () => {
    const payload = JSON.stringify({ title: String(document.title || "").slice(0, ${titleLimit}), icon });
    if (payload === last) return;
    last = payload;
    try { send(payload); } catch {}
  };
  const report = () => {
    timer = 0;
    const url = declared();
    if (url !== iconFor) {
      iconFor = url;
      const mine = ++turn;
      void draw(url).then((data) => {
        if (mine !== turn) return;
        icon = data;
        post();
      });
    }
    post();
  };
  const soon = () => { if (!timer) timer = setTimeout(report, 100); };
  const watch = () => {
    const head = document.head || document.documentElement;
    if (head) new MutationObserver(soon).observe(head, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["href", "rel", "sizes"],
    });
    soon();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
  addEventListener("load", soon);
})();`;

const Payload = z.object({ title: z.string(), icon: z.string() });
const BindingCall = z.object({ name: z.string(), payload: z.string().max(64 * 1024) });
const Navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) });
const Added = z.object({ identifier: z.string() });
const pngDataUrl = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

export interface Identity {
  title?: string | undefined;
  favicon?: string | undefined;
}

/**
 * What a report from the identity world means, or undefined when it is not one. Titles are cut
 * to the wire bound; anything but a bounded PNG data URL is no icon.
 */
export function readIdentity(raw: unknown): Identity | undefined {
  const call = BindingCall.safeParse(raw);
  if (!call.success || call.data.name !== identityBinding) return undefined;
  let parsed: z.infer<typeof Payload>;
  try {
    parsed = Payload.parse(JSON.parse(call.data.payload));
  } catch {
    return undefined;
  }
  const title = parsed.title.replace(/\s+/g, " ").trim().slice(0, titleLimit);
  const favicon =
    parsed.icon.length <= faviconLimit && pngDataUrl.test(parsed.icon) ? parsed.icon : undefined;
  return { ...(title ? { title } : {}), ...(favicon ? { favicon } : {}) };
}

/**
 * Follows one tab's identity on whichever CDP session currently reaches its page. `watch` again
 * after the page's session is replaced (a re-adopted view, a restarted browser). Best effort: an
 * engine that refuses the binding or the script leaves the backend's own title and no favicon.
 */
export class PageIdentity {
  private current: Identity = {};
  private stop = () => {};
  private changed: () => void;
  constructor(changed: () => void) {
    this.changed = changed;
  }
  get title(): string | undefined {
    return this.current.title;
  }
  get favicon(): string | undefined {
    return this.current.favicon;
  }
  watch(cdp: BrowserCdp): void {
    this.stop();
    let stopped = false;
    let script: string | undefined;
    const reported = (raw: unknown) => {
      const identity = readIdentity(raw);
      if (!identity || stopped) return;
      if (identity.title === this.current.title && identity.favicon === this.current.favicon)
        return;
      this.current = identity;
      this.changed();
    };
    // A new document starts with no identity of its own; the backend's title stands in.
    const navigated = (raw: unknown) => {
      const frame = Navigated.safeParse(raw);
      if (!frame.success || frame.data.frame.parentId) return;
      if (this.current.title === undefined && this.current.favicon === undefined) return;
      this.current = {};
      this.changed();
    };
    cdp.on("Runtime.bindingCalled", reported);
    cdp.on("Page.frameNavigated", navigated);
    this.stop = () => {
      stopped = true;
      cdp.off("Runtime.bindingCalled", reported);
      cdp.off("Page.frameNavigated", navigated);
      if (script)
        void cdp
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: script })
          .catch(() => {});
    };
    void (async () => {
      await cdp.send("Runtime.addBinding", {
        name: identityBinding,
        executionContextName: identityWorld,
      });
      const added = Added.safeParse(
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source,
          worldName: identityWorld,
          runImmediately: true,
        }),
      );
      if (!added.success) return;
      if (stopped)
        void cdp
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.data.identifier })
          .catch(() => {});
      else script = added.data.identifier;
    })().catch(() => {});
  }
  close(): void {
    this.stop();
    this.stop = () => {};
  }
}
