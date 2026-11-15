/**
 * The scene runtime (ADR 0150, "Scenes"): the script a Suit's sandbox page loads before the
 * Suit's own `scene.js`. It is the only thing that talks to ace. It hears the host's messages
 * (`SceneHostMessage` in `@ace/protocol/suits`), makes the one canvas, and answers with
 * `ready`, `drawn` and `error` (`SceneMessage`). On a host `sample` it averages the canvas down
 * to a small grid and answers `sample` with its RGBA bytes, for ace's live contrast check; the
 * scene itself takes no part, and a canvas it can't read answers nothing.
 *
 * Glass: a browser's backdrop-filter can't reach into this sandboxed, out-of-process frame, so
 * ace's glass over a scene would show it sharp. The host sends `glass` with the rounded
 * rectangles its glass covers. For each blur it asks for, the runtime keeps one small canvas over
 * the scene's: after every frame it draws the scene's own canvas into it, blurred and saturated,
 * at an eighth to a half of the CSS size, and the browser shows it stretched to the frame and
 * clipped to those rectangles (`clip-path`), so the edges stay crisp and moving the glass costs
 * nothing. The scene takes no part in this either.
 *
 * A scene author writes:
 *
 *   ace.scene({
 *     init(view) {},           // view: { canvas, width, height, pixelRatio, scheme, reduceMotion }
 *     frame(time, view) {},    // one call per host tick; time in ms of running scene time
 *     signal(name) {},         // "working" | "waiting" | "done" | "failed" | "pr-merged"
 *     resize(view) {},         // new width, height or pixelRatio
 *     scheme(scheme) {},       // "light" | "dark"
 *     motion(reduceMotion) {}, // optional
 *   });
 *
 * This is the contract the make-a-suit skill teaches. Only `frame` is required. `view` is one
 * object kept current in place (no allocation per frame); the canvas is sized in device pixels,
 * `width`/`height` are CSS pixels. The scene never schedules its own frames: ace owns the clock.
 *
 * The daemon serves this string as a same-origin script of the sandbox page (the page's CSP is
 * `script-src 'self'`), ahead of `scene.js`.
 */
export const sceneRuntimeScript = `(function (g) {
  'use strict';
  var host = g.parent;
  var doc = g.document;
  var definition = null;
  var info = null;
  var view = null;
  var started = false;
  var failed = false;
  var canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  var style = canvas.style;
  style.position = 'fixed';
  style.inset = '0';
  style.width = '100%';
  style.height = '100%';
  style.display = 'block';
  // The glass layers: the scene, blurred, inside the host's glass rectangles (see "Glass" above).
  var glassRects = [];
  var glassLayers = {};
  var glassBroken = false;
  var GLASS_RECTS_MAX = 32;
  function place() {
    if (canvas.parentNode) return;
    (doc.body || doc.documentElement).appendChild(canvas);
  }
  if (doc.body) place(); else doc.addEventListener('DOMContentLoaded', place);
  function reply(message) { host.postMessage(message, '*'); }
  function words(reason) {
    var text = reason && typeof reason === 'object' && 'message' in reason ? reason.message : reason;
    return String(text === undefined ? 'unknown error' : text).slice(0, 500);
  }
  function fail(reason) {
    if (failed) return;
    failed = true;
    reply({ type: 'error', message: words(reason) });
  }
  function call(name, args) {
    if (failed || !started || !definition) return undefined;
    var fn = definition[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(definition, args); } catch (error) { fail(error); return undefined; }
  }
  function size(width, height, ratio) {
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
  }
  function start() {
    if (started || failed || !definition || !info) return;
    place();
    size(info.width, info.height, info.pixelRatio);
    started = true;
    view = { canvas: canvas, width: info.width, height: info.height, pixelRatio: info.pixelRatio, scheme: info.scheme, reduceMotion: info.reduceMotion };
    try {
      if (typeof definition.init === 'function') definition.init(view);
    } catch (error) { fail(error); return; }
    if (!failed) reply({ type: 'ready' });
  }
  // The canvas averaged to columns x rows by the browser's own scaler; null when unreadable.
  function shrink(columns, rows) {
    try {
      var small = doc.createElement('canvas');
      small.width = columns; small.height = rows;
      var context = small.getContext('2d');
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(canvas, 0, 0, columns, rows);
      return Array.prototype.slice.call(context.getImageData(0, 0, columns, rows).data);
    } catch (error) { return null; }
  }
  function finite(value) { return typeof value === 'number' && isFinite(value); }
  // The host's glass rectangles, kept only when every number is sane; null for a bad message.
  function glassFrom(list) {
    if (!Array.isArray(list) || list.length > GLASS_RECTS_MAX) return null;
    var rects = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || !finite(r.radius) || !finite(r.blur)) return null;
      if (r.width <= 0 || r.height <= 0) continue;
      var saturate = finite(r.saturate) ? Math.min(4, Math.max(0, r.saturate)) : 1;
      rects.push({ x: r.x, y: r.y, width: r.width, height: r.height, radius: Math.max(0, Math.min(r.radius, r.width / 2, r.height / 2)), blur: Math.min(64, Math.max(0, r.blur)), saturate: saturate });
    }
    return rects;
  }
  function glassKey(rect) { return rect.blur + '/' + rect.saturate; }
  // A copy small enough to be cheap and big enough that the blur, not the scaling, sets its look.
  function glassScale(blur) { return Math.min(0.5, Math.max(0.125, 4 / Math.max(blur, 1))); }
  function roundedPath(rect) {
    var x = rect.x, y = rect.y, w = rect.width, h = rect.height, k = rect.radius;
    var arc = 'A' + k + ' ' + k + ' 0 0 1 ';
    return 'M' + (x + k) + ' ' + y + 'H' + (x + w - k) + arc + (x + w) + ' ' + (y + k) +
      'V' + (y + h - k) + arc + (x + w - k) + ' ' + (y + h) +
      'H' + (x + k) + arc + x + ' ' + (y + h - k) +
      'V' + (y + k) + arc + (x + k) + ' ' + y + 'Z';
  }
  function dropLayer(key) {
    var layer = glassLayers[key];
    if (layer.canvas.parentNode) layer.canvas.parentNode.removeChild(layer.canvas);
    delete glassLayers[key];
  }
  // One layer per blur and saturation, shown over the scene and clipped to its rectangles.
  function arrangeGlass() {
    var groups = {};
    for (var i = 0; i < glassRects.length; i++) {
      var key = glassKey(glassRects[i]);
      (groups[key] = groups[key] || []).push(glassRects[i]);
    }
    for (var old in glassLayers) if (!groups[old]) dropLayer(old);
    for (var name in groups) {
      var layer = glassLayers[name];
      if (!layer) {
        var made = doc.createElement('canvas');
        made.setAttribute('aria-hidden', 'true');
        var look = made.style;
        look.position = 'fixed';
        look.inset = '0';
        look.width = '100%';
        look.height = '100%';
        look.display = 'block';
        look.pointerEvents = 'none';
        layer = glassLayers[name] = { canvas: made, blur: groups[name][0].blur, saturate: groups[name][0].saturate };
        (doc.body || doc.documentElement).appendChild(made);
      }
      layer.canvas.style.clipPath = "path('" + groups[name].map(roundedPath).join('') + "')";
    }
  }
  // Each layer: the scene's canvas drawn small through its blur. The source is drawn a little
  // past every edge, so the blur never fades to nothing at the frame's sides.
  function paintGlass() {
    for (var key in glassLayers) {
      var layer = glassLayers[key];
      var scale = glassScale(layer.blur);
      var width = Math.max(1, Math.ceil(info.width * scale));
      var height = Math.max(1, Math.ceil(info.height * scale));
      if (layer.canvas.width !== width) layer.canvas.width = width;
      if (layer.canvas.height !== height) layer.canvas.height = height;
      var context = layer.canvas.getContext('2d');
      var reach = Math.ceil(layer.blur * scale * 2);
      context.clearRect(0, 0, width, height);
      context.filter = 'blur(' + layer.blur * scale + 'px) saturate(' + layer.saturate + ')';
      context.drawImage(canvas, -reach, -reach, width + reach * 2, height + reach * 2);
      context.filter = 'none';
    }
  }
  // Glass is ace's own layer: a failure in it turns glass off and never stops the scene.
  function glassSafely(run) {
    if (glassBroken) return;
    try { run(); } catch (error) {
      glassBroken = true;
      for (var key in glassLayers) dropLayer(key);
    }
  }
  function glaze() { if (started) glassSafely(paintGlass); }
  g.addEventListener('error', function (event) { fail(event.error || event.message); });
  g.addEventListener('unhandledrejection', function (event) { fail(event.reason); });
  Object.defineProperty(g, 'ace', {
    value: Object.freeze({
      scene: function (value) {
        if (definition) { fail('ace.scene was called more than once'); return; }
        if (!value || typeof value.frame !== 'function') { fail('ace.scene needs an object with a frame(time) function'); return; }
        definition = value;
        start();
      },
    }),
    writable: false,
    configurable: false,
  });
  g.addEventListener('message', function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || failed) return;
    switch (data.type) {
      case 'init':
        if (info || !finite(data.width) || !finite(data.height) || !finite(data.pixelRatio)) return;
        info = { width: data.width, height: data.height, pixelRatio: data.pixelRatio, scheme: data.scheme, reduceMotion: data.reduceMotion === true };
        start();
        return;
      case 'resize':
        if (!info || !finite(data.width) || !finite(data.height) || !finite(data.pixelRatio)) return;
        info.width = data.width; info.height = data.height; info.pixelRatio = data.pixelRatio;
        if (!started) return;
        size(data.width, data.height, data.pixelRatio);
        view.width = data.width; view.height = data.height; view.pixelRatio = data.pixelRatio;
        call('resize', [view]);
        return;
      case 'scheme':
        if (data.scheme !== 'light' && data.scheme !== 'dark') return;
        if (info) info.scheme = data.scheme;
        if (view) view.scheme = data.scheme;
        call('scheme', [data.scheme]);
        return;
      case 'motion':
        if (info) info.reduceMotion = data.reduceMotion === true;
        if (view) view.reduceMotion = data.reduceMotion === true;
        call('motion', [data.reduceMotion === true]);
        return;
      case 'signal':
        if (typeof data.signal === 'string') call('signal', [data.signal]);
        return;
      case 'pause':
      case 'resume':
        call(data.type, []);
        return;
      case 'sample': {
        if (!started) return;
        var columns = Math.floor(data.columns), rows = Math.floor(data.rows);
        if (!(columns >= 1 && columns <= 32 && rows >= 1 && rows <= 32) || !finite(data.id)) return;
        var pixels = shrink(columns, rows);
        if (pixels) reply({ type: 'sample', id: data.id, columns: columns, rows: rows, pixels: pixels });
        return;
      }
      case 'glass': {
        var rects = glassFrom(data.rects);
        if (!rects) return;
        glassRects = rects;
        glassSafely(arrangeGlass);
        // A new layer shows the scene's current picture at once (scenes keep it, as sampling
        // needs); a moved one only needs its new clip.
        glaze();
        return;
      }
      case 'tick': {
        if (!started || !finite(data.time)) return;
        var time = data.time;
        var drawn = call('frame', [time, view]);
        if (failed) return;
        if (drawn && typeof drawn.then === 'function')
          drawn.then(function () { if (failed) return; glaze(); reply({ type: 'drawn', time: time }); }, fail);
        else { glaze(); reply({ type: 'drawn', time: time }); }
        return;
      }
    }
  });
})(globalThis);
`;
