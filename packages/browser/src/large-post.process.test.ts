import { expect, it } from "vitest";
import { executablePath, fixture } from "./test-support.ts";

it.skipIf(!executablePath)(
  "a real Chromium worker completes a POST larger than the nested policy envelope limit",
  async () => {
    const f = await fixture();
    await f.navigate();
    const script = `fetch(${JSON.stringify(`${f.url}/data`)}, {method: 'POST', body: 'x'.repeat(1_100_000)})
    .then(response => response.text()).then(value => postMessage(value), error => postMessage(String(error)));`;
    const result = await f.evaluate(`new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([${JSON.stringify(script)}], {type: 'text/javascript'}));
    const worker = new Worker(url);
    worker.onmessage = event => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
    worker.onerror = error => { worker.terminate(); URL.revokeObjectURL(url); reject(error.message); };
  })`);
    expect(result).toBe("response-data");
    expect(await f.evaluate("document.querySelector('button').textContent")).toBe("Save");
  },
);
