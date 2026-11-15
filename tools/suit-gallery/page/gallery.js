// The gallery's host: a small stand-in for ace's scene controller. It loads one scene's sandbox
// page, sends `init`, owns the clock (at most 30 ticks a second), forwards signals and Reduce
// motion, and applies the scene's palette to the mock window.
/** Rounded to half a pixel, so a layout that didn't really move sends the same glass. */
const half = (value) => Math.round(value * 2) / 2;

(() => {
  "use strict";

  const SCENES = ["aurora", "rain-city", "nebula", "abyss", "sunset-drive", "sakura-dusk"];
  const FRAME_MS = 1000 / 30;

  const frame = document.getElementById("scene");
  const status = document.getElementById("status");
  const reduceButton = document.getElementById("reduce");
  const hideButton = document.getElementById("hide");
  const params = new URLSearchParams(location.search);

  let current = SCENES.includes(params.get("scene")) ? params.get("scene") : SCENES[0];
  let reduce = params.get("reduce") === "1";
  let ready = false;
  let sceneTime = 0;
  let lastTick = -Infinity;
  let lastNow = 0;
  let error = "";
  let drawnCount = 0;
  let drawnSince = performance.now();
  let fps = 0;
  let lastContrast = null;

  const post = (message) => frame.contentWindow?.postMessage(message, "*");
  const samples = new Map();
  let sampleId = 0;

  /** The scene's canvas as a small grid, read through the runtime's own `sample` message. */
  function sample() {
    const { columns, rows } = window.galleryContrast;
    return new Promise((resolve, reject) => {
      sampleId += 1;
      samples.set(sampleId, resolve);
      post({ type: "sample", id: sampleId, columns, rows });
      setTimeout(() => samples.delete(sampleId) && reject(new Error("no sample")), 2000);
    });
  }

  /** Worst text contrast over the scene as it is now; the least of them shows in the bar. */
  async function contrast() {
    const results = window.galleryContrast.report(await sample(), frame);
    const least = Math.min(...results.map((r) => r.contrast));
    lastContrast = least;
    show();
    return { least, results };
  }
  const box = () => frame.getBoundingClientRect();

  function show() {
    const parts = [current];
    if (error) parts.push(`error: ${error}`);
    else if (!ready) parts.push("loading");
    else parts.push(reduce ? "still frame" : `${fps.toFixed(0)} fps`);
    if (lastContrast !== null) parts.push(`text contrast ≥ ${lastContrast.toFixed(1)}`);
    status.textContent = parts.join(" · ");
  }

  async function palette(name) {
    const response = await fetch(`/scenes/${name}/palette.json`, { cache: "no-store" });
    if (!response.ok) return;
    const values = await response.json();
    const root = document.documentElement.style;
    for (const [key, value] of Object.entries(values)) {
      if (key === "name") continue;
      root.setProperty(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
    }
    queueGlass();
  }

  function load(name) {
    current = name;
    lastContrast = null;
    ready = false;
    error = "";
    sceneTime = 0;
    for (const button of document.querySelectorAll("#scenes button"))
      button.classList.toggle("on", button.dataset.scene === name);
    const url = new URL(location.href);
    url.searchParams.set("scene", name);
    history.replaceState(null, "", url);
    frame.src = `/scene/${name}.html`;
    void palette(name);
    show();
  }

  frame.addEventListener("load", () => {
    const { width, height } = box();
    post({
      type: "init",
      scheme: "dark",
      width,
      height,
      pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      reduceMotion: reduce,
    });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "ready") {
      ready = true;
      lastGlass = "";
      queueGlass();
      if (reduce) post({ type: "tick", time: sceneTime });
    } else if (data.type === "drawn") {
      drawnCount += 1;
    } else if (data.type === "sample") {
      const waiting = samples.get(data.id);
      samples.delete(data.id);
      waiting?.(data.pixels);
    } else if (data.type === "error") {
      error = data.message;
      console.error(`scene ${current}: ${data.message}`);
    }
    show();
  });

  function loop(now) {
    requestAnimationFrame(loop);
    const elapsed = now - lastNow;
    lastNow = now;
    if (!ready || reduce || error) return;
    sceneTime += Math.min(elapsed, 100);
    if (now - lastTick < FRAME_MS - 2) return;
    lastTick = now;
    post({ type: "tick", time: sceneTime });
    if (now - drawnSince > 1000) {
      fps = (drawnCount * 1000) / (now - drawnSince);
      drawnCount = 0;
      drawnSince = now;
      show();
    }
  }
  requestAnimationFrame(loop);

  // ace's glass over the scene. A browser's backdrop-filter can't blur the sandboxed scene frame,
  // so the host sends the runtime the rectangles its glass covers (`glass`) and the runtime
  // blurs the scene inside them; the glass here keeps only its tint and edge. Re-sent, at most
  // once a frame, whenever the layout, the palette or the UI's visibility changes.
  let glassQueued = false;
  let lastGlass = "";
  function glassRects() {
    if (document.getElementById("app").classList.contains("hidden")) return [];
    const origin = box();
    const rects = [];
    for (const element of document.querySelectorAll("#app .glass")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = getComputedStyle(element);
      rects.push({
        x: half(rect.left - origin.left),
        y: half(rect.top - origin.top),
        width: half(rect.width),
        height: half(rect.height),
        radius: half(
          Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2),
        ),
        blur: parseFloat(style.getPropertyValue("--blur")) || 0,
        saturate: parseFloat(style.getPropertyValue("--saturate")) || 1,
      });
    }
    return rects;
  }
  function queueGlass() {
    if (glassQueued) return;
    glassQueued = true;
    requestAnimationFrame(() => {
      glassQueued = false;
      if (!ready) return;
      const rects = glassRects();
      const key = JSON.stringify(rects);
      if (key === lastGlass) return;
      lastGlass = key;
      post({ type: "glass", rects });
      if (reduce) post({ type: "tick", time: sceneTime });
    });
  }
  new ResizeObserver(queueGlass).observe(document.getElementById("app"));

  new ResizeObserver(() => {
    if (!ready) return;
    const { width, height } = box();
    post({ type: "resize", width, height, pixelRatio: Math.min(2, window.devicePixelRatio || 1) });
    if (reduce) post({ type: "tick", time: sceneTime });
  }).observe(frame);

  const scenes = document.getElementById("scenes");
  SCENES.forEach((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.scene = name;
    button.textContent = name.replace("-", " ");
    button.title = `Scene ${index + 1}`;
    button.addEventListener("click", () => load(name));
    scenes.append(button);
  });

  for (const button of document.querySelectorAll("[data-signal]")) {
    button.addEventListener("click", () => {
      post({ type: "signal", signal: button.dataset.signal });
      button.classList.add("fired");
      setTimeout(() => button.classList.remove("fired"), 600);
    });
  }

  function setReduce(value) {
    reduce = value;
    reduceButton.setAttribute("aria-pressed", String(reduce));
    post({ type: "motion", reduceMotion: reduce });
    if (reduce) post({ type: "tick", time: sceneTime });
    show();
  }
  reduceButton.addEventListener("click", () => setReduce(!reduce));
  reduceButton.setAttribute("aria-pressed", String(reduce));

  function setHidden(value) {
    const hidden = document.getElementById("app").classList.toggle("hidden", value);
    hideButton.setAttribute("aria-pressed", String(hidden));
    queueGlass();
  }
  hideButton.addEventListener("click", () => setHidden(undefined));

  window.addEventListener("keydown", (event) => {
    const index = Number(event.key) - 1;
    if (index >= 0 && index < SCENES.length) load(SCENES[index]);
  });

  // Hooks for scripted checks: `gallery.signal("pr-merged")`, `gallery.load("nebula")`.
  window.gallery = {
    load,
    signal: (name) => post({ type: "signal", signal: name }),
    reduce: setReduce,
    hide: setHidden,
    glass: glassRects,
    state: () => ({ scene: current, ready, error, fps, sceneTime }),
    contrast,
  };

  load(current);
})();
