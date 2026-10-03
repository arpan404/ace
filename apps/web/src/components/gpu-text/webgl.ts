import type { GlyphAtlas } from "./atlas.ts";
import type { TextBackend } from "./backend.ts";
import { palette, quadFloats } from "./layout.ts";

const vertex = `#version 300 es
in vec2 corner;
in vec4 rect;
in vec4 uv;
in float tone;
uniform vec2 viewport;
uniform vec4 colors[${palette.length}];
out vec2 vUv;
out vec4 vColor;
void main() {
  vec2 p = rect.xy + corner * rect.zw;
  vec2 clip = p / viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = mix(uv.xy, uv.zw, corner);
  vColor = colors[int(tone + 0.5)];
}`;
const fragment = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D atlas;
out vec4 color;
void main() {
  float ink = texture(atlas, vUv).a * vColor.a;
  color = vec4(vColor.rgb * ink, ink);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log ?? "WebGL shader");
  }
  return shader;
}

/**
 * WebGL2 fallback: instanced quads, one draw call per frame. Everything it creates is deleted on
 * `dispose` (or when setting up fails) and the context is given up at once, rather than left
 * for the collector: browsers keep few live contexts and drop the oldest past that.
 */
export function webglBackend(canvas: HTMLCanvasElement, atlas: GlyphAtlas): TextBackend {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error("No WebGL2");
  const cleanups: (() => void)[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    return setup(gl, canvas, atlas, cleanups, release);
  } catch (error) {
    release();
    throw error;
  }
}

function setup(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  atlas: GlyphAtlas,
  cleanups: (() => void)[],
  release: () => void,
): TextBackend {
  const program = gl.createProgram();
  cleanups.push(() => gl.deleteProgram(program));
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = compile(gl, type, source);
    gl.attachShader(program, shader);
    cleanups.push(() => {
      gl.detachShader(program, shader);
      gl.deleteShader(shader);
    });
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "WebGL link");
  gl.useProgram(program);
  const vao = gl.createVertexArray();
  cleanups.push(() => gl.deleteVertexArray(vao));
  gl.bindVertexArray(vao);
  const corners = gl.createBuffer();
  cleanups.push(() => gl.deleteBuffer(corners));
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW,
  );
  const cornerAt = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(cornerAt);
  gl.vertexAttribPointer(cornerAt, 2, gl.FLOAT, false, 0, 0);
  const instances = gl.createBuffer();
  cleanups.push(() => gl.deleteBuffer(instances));
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  const stride = quadFloats * 4;
  for (const [name, size, offset] of [
    ["rect", 4, 0],
    ["uv", 4, 16],
    ["tone", 1, 32],
  ] as const) {
    const at = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(at, 1);
  }
  const texture = gl.createTexture();
  cleanups.push(() => gl.deleteTexture(texture));
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const viewport = gl.getUniformLocation(program, "viewport");
  const colors = gl.getUniformLocation(program, "colors");
  let uploaded = -1;
  return {
    kind: "webgl2",
    colors(rgba) {
      gl.uniform4fv(colors, rgba);
    },
    draw(frame, size) {
      const width = Math.round(size.width * size.scale);
      const height = Math.round(size.height * size.scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (uploaded !== atlas.version) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
        uploaded = atlas.version;
      }
      gl.uniform2f(viewport, size.width, size.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        frame.quads.subarray(0, frame.count * quadFloats),
        gl.STREAM_DRAW,
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, frame.count);
    },
    dispose: release,
  };
}
