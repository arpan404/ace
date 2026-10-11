import { z } from "zod";
import type { BrowserCdp, BackendLog } from "./backend.ts";
import { createTextRedactor, isSecretKey } from "@ace/redaction";
export function redactBrowserText(text: string): string {
  return createTextRedactor({})(text);
}
export function redactBrowserUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys())
      if (isSecretKey(key)) url.searchParams.set(key, "[redacted]");
    return url.href.slice(0, 8192);
  } catch {
    return redactBrowserText(raw).slice(0, 8192);
  }
}
interface Response {
  cdp: BrowserCdp;
  id: string;
  bytes: number;
  done: boolean;
  mime: string;
}
/** No bodies/headers retained. CDP lengths bound body retrieval before requesting bytes. */
export class BrowserInspection {
  private enabled = true;
  private epoch = 0;
  privacy(enabled: boolean): void {
    const epoch = ++this.epoch;
    this.enabled = false;
    this.responses.clear();
    this.requests.clear();
    // Drop Chromium's retained bodies before accepting another shared response.
    void Promise.all(
      [...this.stops.keys()].map(async (cdp) => {
        await cdp.send("Network.disable");
        if (!enabled && epoch === this.epoch) await this.enable(cdp);
      }),
    )
      .then(() => {
        if (epoch === this.epoch) this.enabled = !enabled;
      })
      .catch(() => {
        /* Inspection stays disabled if the buffer cannot be cleared. */
      });
  }
  private requests = new Map<string, { cdp: BrowserCdp; url: string }>();
  private responses = new Map<string, Response>();
  private stops = new Map<BrowserCdp, (() => void)[]>();
  private log: (entry: BackendLog) => void;
  constructor(log: (entry: BackendLog) => void) {
    this.log = log;
  }
  async attach(cdp: BrowserCdp, tabId: string): Promise<void> {
    if (this.stops.has(cdp)) return;
    const stops: (() => void)[] = [];
    this.stops.set(cdp, stops);
    const bind = (method: string, listener: (raw: unknown) => void) => {
      cdp.on(method, listener);
      stops.push(() => {
        cdp.off(method, listener);
      });
    };
    bind("Network.requestWillBeSent", (raw) => {
      if (!this.enabled) return;
      const parsed = z
        .object({ requestId: z.string(), request: z.object({ url: z.string() }) })
        .safeParse(raw);
      if (!parsed.success) return;
      if (this.requests.size >= 200) this.requests.delete(this.requests.keys().next().value ?? "");
      this.requests.set(`${tabId}:${parsed.data.requestId}`, {
        cdp,
        url: redactBrowserUrl(parsed.data.request.url),
      });
    });
    bind("Network.loadingFailed", (raw) => {
      if (!this.enabled) return;
      const parsed = z.object({ requestId: z.string(), errorText: z.string() }).safeParse(raw);
      if (!parsed.success) return;
      const requestId = `${tabId}:${parsed.data.requestId}`,
        request = this.requests.get(requestId);
      this.requests.delete(requestId);
      this.responses.delete(requestId);
      this.log({
        kind: "network",
        type: "failed",
        requestId,
        ...(request ? { url: request.url } : {}),
        text: `${request?.url ?? "Request"} ${parsed.data.errorText}`,
      });
    });
    bind("Network.responseReceived", (raw) => {
      if (!this.enabled) return;
      const parsed = z
        .object({
          requestId: z.string(),
          response: z.object({ url: z.string(), status: z.number(), mimeType: z.string() }),
        })
        .safeParse(raw);
      if (!parsed.success) return;
      const { requestId, response } = parsed.data,
        key = `${tabId}:${requestId}`;
      if (!this.requests.has(key)) return;
      if (this.responses.size >= 200)
        this.responses.delete(this.responses.keys().next().value ?? "");
      this.responses.set(key, {
        cdp,
        id: requestId,
        bytes: 0,
        done: false,
        mime: response.mimeType,
      });
      this.log({
        kind: "network",
        type: "response",
        requestId: key,
        url: redactBrowserUrl(response.url),
        status: response.status,
        text: `${response.status} ${redactBrowserUrl(response.url)}`,
      });
    });
    bind("Network.dataReceived", (raw) => {
      if (!this.enabled) return;
      const parsed = z.object({ requestId: z.string(), dataLength: z.number() }).safeParse(raw);
      if (parsed.success) {
        const response = this.responses.get(`${tabId}:${parsed.data.requestId}`);
        if (response) response.bytes += parsed.data.dataLength;
      }
    });
    bind("Network.loadingFinished", (raw) => {
      if (!this.enabled) return;
      const parsed = z
        .object({ requestId: z.string(), encodedDataLength: z.number() })
        .safeParse(raw);
      if (parsed.success) {
        const key = `${tabId}:${parsed.data.requestId}`;
        this.requests.delete(key);
        const response = this.responses.get(key);
        if (response) {
          // A process-swapping iframe can start on its parent and finish in this session.
          response.cdp = cdp;
          response.done = true;
          response.bytes = Math.max(response.bytes, parsed.data.encodedDataLength);
        }
      }
    });
    try {
      if (this.enabled) await this.enable(cdp);
    } catch (error) {
      this.detach(cdp);
      throw error;
    }
  }
  private enable(cdp: BrowserCdp): Promise<unknown> {
    return cdp.send("Network.enable", {
      maxTotalBufferSize: 1024 * 1024,
      maxResourceBufferSize: 256 * 1024,
      maxPostDataSize: 0,
    });
  }
  async body(requestId: string): Promise<unknown> {
    const epoch = this.epoch;
    if (!this.enabled) throw new Error("Response unavailable");
    const entry = this.responses.get(requestId);
    if (!entry?.done) throw new Error("Response unavailable or still loading");
    if (entry.bytes > 256 * 1024 || !/text|json|javascript|xml|svg/i.test(entry.mime))
      throw new Error("Response body exceeds limit or is binary");
    const raw = z
      .object({ body: z.string().max(512 * 1024), base64Encoded: z.boolean() })
      .parse(await entry.cdp.send("Network.getResponseBody", { requestId: entry.id }));
    if (!this.enabled || epoch !== this.epoch) throw new Error("Response unavailable");
    const body = raw.base64Encoded ? Buffer.from(raw.body, "base64").toString("utf8") : raw.body;
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Response body exceeds limit");
    return { requestId, mimeType: entry.mime, body: redactBrowserText(body), redacted: true };
  }
  detach(cdp: BrowserCdp): void {
    for (const stop of this.stops.get(cdp) ?? []) stop();
    this.stops.delete(cdp);
    for (const [id, request] of this.requests) if (request.cdp === cdp) this.requests.delete(id);
    for (const [id, entry] of this.responses) if (entry.cdp === cdp) this.responses.delete(id);
  }
  clear(): void {
    for (const cdp of this.stops.keys()) this.detach(cdp);
    this.responses.clear();
  }
}
