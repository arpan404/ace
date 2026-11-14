/**
 * The scene runtime (ADR 0150, "Scenes"): the script a Suit's sandbox page loads before the
 * Suit's own `scene.js`. It is the only thing that talks to ace. It hears the host's messages
 * (`SceneHostMessage` in `@ace/protocol/suits`), makes the one canvas, and answers with
 * `ready`, `drawn` and `error` (`SceneMessage`).
 *
 * A scene author writes:
 *
 *   ace.scene({
 *     init(canvas, info) {},   // info: { width, height, pixelRatio, scheme, reduceMotion }
 *     frame(time) {},          // one call per host tick; time in ms of running scene time
 *     signal(name) {},         // "working" | "waiting" | "done" | "failed" | "pr-merged"
 *     resize(width, height) {},
 *     scheme(scheme) {},       // "light" | "dark"
 *     motion(reduceMotion) {}, // optional
 *   });
 *
 * Only `frame` is required. The canvas is sized in device pixels; `width`/`height` are CSS
 * pixels. The scene never schedules its own frames: ace owns the clock.
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
    try {
      if (typeof definition.init === 'function') definition.init(canvas, Object.freeze(Object.assign({}, info)));
    } catch (error) { fail(error); return; }
    if (!failed) reply({ type: 'ready' });
  }
  function finite(value) { return typeof value === 'number' && isFinite(value); }
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
        if (started) size(data.width, data.height, data.pixelRatio);
        call('resize', [data.width, data.height]);
        return;
      case 'scheme':
        if (data.scheme !== 'light' && data.scheme !== 'dark') return;
        if (info) info.scheme = data.scheme;
        call('scheme', [data.scheme]);
        return;
      case 'motion':
        if (info) info.reduceMotion = data.reduceMotion === true;
        call('motion', [data.reduceMotion === true]);
        return;
      case 'signal':
        if (typeof data.signal === 'string') call('signal', [data.signal]);
        return;
      case 'pause':
      case 'resume':
        call(data.type, []);
        return;
      case 'tick': {
        if (!started || !finite(data.time)) return;
        var time = data.time;
        var drawn = call('frame', [time]);
        if (failed) return;
        if (drawn && typeof drawn.then === 'function')
          drawn.then(function () { if (!failed) reply({ type: 'drawn', time: time }); }, fail);
        else reply({ type: 'drawn', time: time });
        return;
      }
    }
  });
})(globalThis);
`;
