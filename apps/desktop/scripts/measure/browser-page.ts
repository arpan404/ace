import { createServer } from "node:http";

/**
 * A page that behaves like a busy web app: a large DOM, a canvas animated every frame and a
 * 16 ms interval that rewrites text. Its CPU use shows whether a hidden view is throttled.
 */
const html = `<!doctype html><html><head><title>measure</title></head><body>
<canvas id="c" width="800" height="200"></canvas><p id="t"></p><ul id="l"></ul>
<script>
const list = document.getElementById("l");
for (let i = 0; i < 3000; i++) { const li = document.createElement("li"); li.textContent = "row " + i + " " + "x".repeat(40); list.append(li); }
const ctx = document.getElementById("c").getContext("2d");
let f = 0;
(function frame() { f++; ctx.fillStyle = "hsl(" + (f % 360) + ",70%,50%)"; ctx.fillRect((f * 7) % 800, 0, 20, 200); requestAnimationFrame(frame); })();
setInterval(() => { document.getElementById("t").textContent = "tick " + Date.now() + " " + Math.random(); }, 16);
</script></body></html>`;

export async function serveTestPage(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test page address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
