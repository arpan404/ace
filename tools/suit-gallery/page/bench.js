// Frame-time bench: loads each scene.js with a stand-in `ace.scene`, drives it directly and
// times each frame:
// - frame+sync: the frame call plus a 1-pixel readPixels, which ends the render pass and waits
//   for the GPU to finish it. This is the number to read: an upper bound on CPU + GPU per frame.
// - timer query: EXT_disjoint_timer_query_webgl2 when offered; on macOS it reads high and noisy,
//   so it is shown for reference only.
// Frames drawn back to back without a wait can't be timed as a batch: on Apple GPUs, hidden
// surface removal shades only the last of several opaque full-screen draws in one pass.
const quantile = (values, q) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const ms = (value) => (value === undefined ? "n/a" : `${value.toFixed(2)} ms`);
const tick = () => new Promise((resolve) => requestAnimationFrame(resolve));

(() => {
  "use strict";

  const SCENES = ["aurora", "rain-city", "nebula", "abyss", "sunset-drive", "sakura-dusk"];
  const WIDTH = 1440;
  const HEIGHT = 900;
  const RATIO = 2;
  const WARM = 30;
  const FRAMES = 150;

  let captured = null;
  let lastContext = null;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = getContext.apply(this, args);
    if (args[0] === "webgl2") lastContext = context;
    return context;
  };
  Object.defineProperty(window, "ace", {
    value: { scene: (definition) => (captured = definition) },
  });

  function load(name) {
    return new Promise((resolve, reject) => {
      captured = null;
      const script = document.createElement("script");
      script.src = `/bench/${name}.js`;
      script.addEventListener("load", () => resolve(captured));
      script.addEventListener("error", reject);
      document.body.append(script);
    });
  }

  async function gpuTimes(gl, definition, view, start, count) {
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext) return undefined;
    const queries = [];
    for (let i = 0; i < count; i += 1) {
      const query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      definition.frame(start + i * 33.3, view);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      queries.push(query);
      if (i % 10 === 9) await tick();
    }
    const times = [];
    for (let tries = 0; tries < 200 && times.length < queries.length; tries += 1) {
      await tick();
      times.length = 0;
      for (const query of queries) {
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      }
    }
    if (gl.getParameter(ext.GPU_DISJOINT_EXT) || times.length < queries.length) return undefined;
    return times;
  }

  function syncTimes(gl, definition, view, start, count) {
    const pixel = new Uint8Array(4);
    const times = [];
    for (let i = 0; i < count; i += 1) {
      const begin = performance.now();
      definition.frame(start + i * 33.3, view);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      times.push(performance.now() - begin);
    }
    return times;
  }

  /** One scene, in its own document: init, warm up, time, and report the row to the parent. */
  async function measure(name) {
    const definition = await load(name);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * RATIO;
    canvas.height = HEIGHT * RATIO;
    document.body.append(canvas);
    const view = {
      canvas,
      width: WIDTH,
      height: HEIGHT,
      pixelRatio: RATIO,
      scheme: "dark",
      reduceMotion: false,
    };
    definition.init(view);
    const gl = lastContext;
    syncTimes(gl, definition, view, 0, WARM);
    const gpu = await gpuTimes(gl, definition, view, 1000, FRAMES);
    const sync = syncTimes(gl, definition, view, 10_000, FRAMES);
    definition.signal("working");
    definition.signal("pr-merged");
    const signalled = syncTimes(gl, definition, view, 15_000, FRAMES);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return {
      backing: `${canvas.width}×${canvas.height}`,
      gpuMedian: gpu && quantile(gpu, 0.5),
      syncMedian: quantile(sync, 0.5),
      syncP95: quantile(sync, 0.95),
      signalledP95: quantile(signalled, 0.95),
    };
  }

  /** Each scene runs in a fresh same-origin frame, so scenes never share a document. */
  function inFrame(name) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;border:0";
      const heard = (event) => {
        if (event.source !== frame.contentWindow || event.data?.scene !== name) return;
        window.removeEventListener("message", heard);
        frame.remove();
        if (event.data.error) reject(new Error(`${name}: ${event.data.error}`));
        else resolve(event.data.row);
      };
      window.addEventListener("message", heard);
      frame.src = `bench.html?scene=${name}`;
      document.body.append(frame);
    });
  }

  async function run() {
    const table = document.getElementById("results");
    const results = {};
    for (const name of SCENES) {
      document.getElementById("state").textContent = `running ${name}…`;
      const row = await inFrame(name);
      results[name] = row;
      const tr = document.createElement("tr");
      for (const cell of [
        name,
        row.backing,
        ms(row.syncMedian),
        ms(row.syncP95),
        ms(row.signalledP95),
        ms(row.gpuMedian),
      ]) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.append(td);
      }
      table.append(tr);
    }
    document.getElementById("state").textContent = "done";
    window.benchResults = results;
  }

  const single = new URLSearchParams(location.search).get("scene");
  if (single && SCENES.includes(single))
    measure(single).then(
      (row) => parent.postMessage({ scene: single, row }, location.origin),
      (error) =>
        parent.postMessage(
          { scene: single, error: String(error?.message ?? error) },
          location.origin,
        ),
    );
  else
    run().catch((error) => {
      document.getElementById("state").textContent = `failed: ${error?.message ?? error}`;
      console.error(error);
    });
})();
