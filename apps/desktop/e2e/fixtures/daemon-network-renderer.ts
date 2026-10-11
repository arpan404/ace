import { authorizeDaemonUrl } from "../../../web/src/boot/daemon-network.ts";

const origins = new URLSearchParams(location.hash.slice(1));
const selected = origins.get("selected");
const other = origins.get("other");
if (!selected || !other) throw new Error("Missing test daemon origins");
const output = document.querySelector("output");
if (!output) throw new Error("Missing connection status");
const worker = new Worker("/worker.js");
worker.onmessage = (event: MessageEvent<unknown>) => {
  output.textContent = typeof event.data === "string" ? event.data : "Invalid response";
};
for (const [label, action] of [
  ["Probe selected HTTPS", () => worker.postMessage({ origin: selected, protocol: "HTTPS" })],
  ["Probe selected WSS", () => worker.postMessage({ origin: selected, protocol: "WSS" })],
  ["Probe other HTTPS", () => worker.postMessage({ origin: other, protocol: "HTTPS" })],
  ["Probe other WSS", () => worker.postMessage({ origin: other, protocol: "WSS" })],
  [
    "Select daemon",
    async () => {
      await authorizeDaemonUrl(selected);
      output.textContent = "Selected";
    },
  ],
] as const) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", () => {
    output.textContent = "Connecting";
    void action();
  });
  document.body.append(button);
}
