import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fixtureFiles } from "./fixture-files.ts";

/** The local pages every engine is driven against. Nothing here knows which engine loads it. */
export interface FixtureSite {
  /** `http://127.0.0.1:<port>`: the site the scenarios browse. */
  origin: string;
  /** The same server as `http://localhost:<port>`: another site, for cross-site frames. */
  crossSite: string;
  close(): Promise<void>;
}

const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const pages: Record<string, (host: string) => string> = {
  "/": () => html("Conformance home", `<h1>Home page</h1>`),
  "/landing": () => html("Landing", `<h1>Landed after redirects</h1>`),
  "/bounce": () =>
    html(
      "Bounce",
      `<h1>Bouncing</h1><script>addEventListener('load', () => location.replace('/bounced'));</script>`,
    ),
  "/bounced": () => html("Bounced", `<h1>Bounced page</h1>`),
  "/form": () =>
    html(
      "Form",
      `<input aria-label="Name"><button onclick="out.textContent='Saved '+document.querySelector('input').value">Save</button>
<input aria-label="Agree" type="checkbox">
<select aria-label="Choice"><option value="a">Apple</option><option value="b">Banana</option></select>
<input aria-label="Keys" onkeydown="if(event.key==='Enter')out.textContent='Entered '+this.value">
<div id="out" role="status" aria-label="Result"></div>`,
    ),
  "/dialogs": () =>
    html(
      "Dialogs",
      `<button onclick="alert('Heads up');document.body.dataset.alerted='yes'">Alert</button>
<button onclick="document.body.dataset.confirmed=String(confirm('Sure?'))">Confirm</button>
<button onclick="document.body.dataset.prompted=String(prompt('Name?','default'))">Prompt</button>`,
    ),
  "/download": () =>
    html("Download", `<a href="/files/report.zip">Get report</a><p>Download page</p>`),
  "/upload": () => html("Upload", `<p>Upload page</p><input type="file" aria-label="Attachment">`),
  "/frames": (host) => {
    const port = host.split(":")[1] ?? "";
    return html(
      "Frames",
      `<iframe title="same" src="/frame?label=Same"></iframe>
<iframe title="cross" src="http://localhost:${port}/frame?label=Cross"></iframe>
<script>let loaded=0;for(const f of document.querySelectorAll('iframe'))f.addEventListener('load',()=>{if(++loaded===2)document.body.insertAdjacentHTML('beforeend','<p>Frames ready</p>')});</script>`,
    );
  },
  "/popup": () =>
    html("Popup opener", `<a href="/popup-target" target="_blank">Open popup</a><p>Opener</p>`),
  "/popup-target": () => html("Popup target", `<h1>Popup page</h1>`),
  "/logs": () =>
    html(
      "Logs",
      `<p>Logging page</p><script>console.log('conformance-console-marker');fetch('/api/ping').then(r=>r.text()).then(t=>document.body.insertAdjacentHTML('beforeend','<p>Ping '+t+'</p>'));</script>`,
    ),
  "/identity": () =>
    `<!doctype html><html><head><title>Identity page</title><link rel="icon" href="/files/icon.png"></head><body><p>Identity ready</p><button onclick="document.title='Renamed (1)'">Rename</button></body></html>`,
  "/files": () =>
    html(
      "Files",
      `<p>Files page</p><a href="/files/doc.pdf">Open PDF</a> <a href="/files/photo.png">Open image</a> <a href="/files/archive.zip">Get archive</a>`,
    ),
  "/annotate": () =>
    html(
      "Annotate",
      `<main style="font:16px sans-serif"><p class="lead" style="margin:60px;width:300px">Pin this paragraph</p></main>
<script>window.pageClicks=0;document.addEventListener('click',()=>window.pageClicks++);</script>`,
    ),
};

function serve(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://fixture");
  const hop = /^\/redirect\/(\d+)$/.exec(url.pathname);
  if (hop) {
    const left = Number(hop[1]);
    response.writeHead(302, { location: left > 1 ? `/redirect/${left - 1}` : "/landing" });
    response.end();
    return;
  }
  if (url.pathname === "/frame") {
    const label = (url.searchParams.get("label") ?? "Frame").replace(/[^A-Za-z]/g, "");
    response.setHeader("Content-Type", "text/html");
    response.end(
      html(
        `${label} frame`,
        `<input aria-label="${label} frame input"><button onclick="this.textContent='${label} clicked'">${label} frame button</button>`,
      ),
    );
    return;
  }
  if (url.pathname === "/files/report.zip") {
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=report.zip",
    });
    response.end("conformance-download");
    return;
  }
  const file = fixtureFiles[url.pathname];
  if (file) {
    response.writeHead(200, { "Content-Type": file.type });
    response.end(file.body());
    return;
  }
  if (url.pathname === "/api/ping") {
    response.setHeader("Content-Type", "text/plain");
    response.end("pong");
    return;
  }
  const page = pages[url.pathname];
  if (!page) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(page(request.headers.host ?? ""));
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const server = createServer(serve);
  // Every interface, so `localhost` reaches it whether it resolves to IPv4 or IPv6.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture site has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    crossSite: `http://localhost:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
