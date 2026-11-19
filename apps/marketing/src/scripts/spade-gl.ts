import type { SpadeMesh } from "./spade-glb.ts";

/*
 * The little WebGL Spade needs: column-major 4×4 matrices and one shader. Every part of Spade
 * lies on its head's sphere, so the shader takes each normal from the head's centre instead of
 * reading it from the model. The light matches the approved look: a soft hemisphere, a key from
 * the upper left, a dim fill from the right, a rim from behind, a faint specular, then the
 * Khronos neutral tone curve and sRGB.
 */

export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

export function rotationX(angle: number): Mat4 {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationY(angle: number): Mat4 {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

const vertex = `#version 300 es
in vec3 position;
uniform mat4 model;
uniform mat4 viewProjection;
out vec3 world;
void main() {
  vec4 placed = model * vec4(position, 1.0);
  world = placed.xyz;
  gl_Position = viewProjection * placed;
}`;

const fragment = `#version 300 es
precision highp float;
in vec3 world;
uniform vec3 centre;
uniform vec3 eye;
uniform vec3 colour;
uniform float roughness;
out vec4 shade;
const float PI = 3.14159265;
const vec3 sky = vec3(0.95);
const vec3 ground = vec3(0.32);
const vec3 lightFrom[3] = vec3[3](normalize(vec3(-3, 4, 4)), normalize(vec3(4, 0.5, 3)), normalize(vec3(1, 3, -4)));
const float lightPower[3] = float[3](2.6, 0.3, 1.4);

vec3 neutral(vec3 c) {
  float x = min(c.r, min(c.g, c.b));
  c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(c.r, max(c.g, c.b));
  const float start = 0.76;
  if (peak < start) return c;
  float d = 1.0 - start;
  float top = 1.0 - d * d / (peak + d - start);
  c *= top / peak;
  return mix(c, vec3(top), 1.0 - 1.0 / (0.15 * (peak - top) + 1.0));
}

void main() {
  vec3 n = normalize(world - centre);
  vec3 v = normalize(eye - world);
  vec3 diffuse = colour / PI;
  vec3 light = mix(ground, sky, 0.5 * n.y + 0.5) * diffuse;
  float a = max(roughness * roughness, 0.03);
  float shine = 2.0 / (a * a) - 2.0;
  for (int i = 0; i < 3; i++) {
    float lit = max(dot(n, lightFrom[i]), 0.0);
    vec3 h = normalize(lightFrom[i] + v);
    float specular = (shine + 8.0) / (8.0 * PI) * pow(max(dot(n, h), 0.0), shine) * 0.04;
    light += lightPower[i] * lit * (diffuse + specular);
  }
  shade = vec4(pow(neutral(light), vec3(1.0 / 2.2)), 1.0);
}`;

export interface Drawable {
  mesh: SpadeMesh;
  vao: WebGLVertexArrayObject;
  count: number;
  type: number;
}

export interface SpadeProgram {
  draw(item: Drawable, model: Mat4, colour: readonly number[], roughness: number): void;
  frame(viewProjection: Mat4, eye: readonly number[], centre: readonly number[]): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("no shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
  }
  return shader;
}

export function spadeProgram(gl: WebGL2RenderingContext): SpadeProgram {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, "position");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "program failed");
  }
  gl.useProgram(program);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = {
    model: at("model"),
    viewProjection: at("viewProjection"),
    centre: at("centre"),
    eye: at("eye"),
    colour: at("colour"),
    roughness: at("roughness"),
  };
  return {
    frame(viewProjection, eye, centre) {
      gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
      gl.uniform3fv(uniforms.eye, eye);
      gl.uniform3fv(uniforms.centre, centre);
    },
    draw(item, model, colour, roughness) {
      gl.uniformMatrix4fv(uniforms.model, false, model);
      gl.uniform3fv(uniforms.colour, colour);
      gl.uniform1f(uniforms.roughness, roughness);
      gl.bindVertexArray(item.vao);
      gl.drawElements(gl.TRIANGLES, item.count, item.type, 0);
    },
  };
}

/** Puts a mesh's positions and indices on the GPU. */
export function upload(gl: WebGL2RenderingContext, mesh: SpadeMesh): Drawable {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const wide = mesh.indices instanceof Uint32Array;
  return {
    mesh,
    vao,
    count: mesh.indices.length,
    type: wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
  };
}
