import type { GlyphAtlas } from "./atlas.ts";
import type { TextBackend } from "./backend.ts";
import { palette, quadFloats } from "./layout.ts";

const shader = /* wgsl */ `
struct Uniforms { viewport: vec2f, pad: vec2f, colors: array<vec4f, ${palette.length}> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var nearest: sampler;
struct In {
  @builtin(vertex_index) vertex: u32,
  @location(0) rect: vec4f,
  @location(1) uv: vec4f,
  @location(2) tone: f32,
};
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vs(input: In) -> Out {
  let corners = array(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let corner = corners[input.vertex];
  let p = input.rect.xy + corner * input.rect.zw;
  let clip = p / u.viewport * 2.0 - 1.0;
  var out: Out;
  out.position = vec4f(clip.x, -clip.y, 0.0, 1.0);
  out.uv = mix(input.uv.xy, input.uv.zw, corner);
  out.color = u.colors[u32(input.tone + 0.5)];
  return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f {
  let ink = textureSample(atlas, nearest, input.uv).a * input.color.a;
  return vec4f(input.color.rgb * ink, ink);
}`;

// Usage flags by their WebGPU spec values (the DOM typings here lack the namespaces).
const buffer = { copyDst: 8, vertex: 32, uniform: 64 };
const textureUsage = { copyDst: 2, binding: 4, attachment: 16 };

interface CanvasGpu {
  configure(options: {
    device: GPUDevice;
    format: GPUTextureFormat;
    alphaMode: "premultiplied";
  }): void;
  getCurrentTexture(): GPUTexture;
}
const isGpuContext = (context: unknown): context is CanvasGpu =>
  typeof context === "object" &&
  context !== null &&
  "configure" in context &&
  "getCurrentTexture" in context;

/** WebGPU: one instanced draw per frame from a reused instance buffer. */
export async function webgpuBackend(
  canvas: HTMLCanvasElement,
  atlas: GlyphAtlas,
  onError: () => void,
): Promise<TextBackend> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  // Some platforms hand out an adapter but cannot present to a canvas (headless shells, broken
  // drivers): the first validation error hands the view back to the next renderer.
  let failed = false;
  device.addEventListener("uncapturederror", () => {
    if (failed) return;
    failed = true;
    onError();
  });
  const context: unknown = canvas.getContext("webgpu");
  if (!isGpuContext(context)) throw new Error("No WebGPU canvas");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });
  const module = device.createShaderModule({ code: shader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: quadFloats * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
            { shaderLocation: 2, offset: 32, format: "float32" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  const uniforms = device.createBuffer({
    size: 16 + palette.length * 16,
    usage: buffer.uniform | buffer.copyDst,
  });
  const texture = device.createTexture({
    size: [atlas.canvas.width, atlas.canvas.height],
    format: "rgba8unorm",
    usage: textureUsage.binding | textureUsage.copyDst | textureUsage.attachment,
  });
  const bindings = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: texture.createView() },
      {
        binding: 2,
        resource: device.createSampler({ magFilter: "nearest", minFilter: "nearest" }),
      },
    ],
  });
  let instances: GPUBuffer | undefined;
  let uploaded = -1;
  return {
    kind: "webgpu",
    colors(rgba) {
      device.queue.writeBuffer(uniforms, 16, rgba);
    },
    draw(frame, size) {
      const width = Math.round(size.width * size.scale);
      const height = Math.round(size.height * size.scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (uploaded !== atlas.version) {
        device.queue.copyExternalImageToTexture({ source: atlas.canvas }, { texture }, [
          atlas.canvas.width,
          atlas.canvas.height,
        ]);
        uploaded = atlas.version;
      }
      device.queue.writeBuffer(uniforms, 0, new Float32Array([size.width, size.height, 0, 0]));
      const bytes = Math.max(16, frame.count * quadFloats * 4);
      if (!instances || instances.size < bytes) {
        instances?.destroy();
        instances = device.createBuffer({
          size: bytes * 2,
          usage: buffer.vertex | buffer.copyDst,
        });
      }
      if (frame.count)
        device.queue.writeBuffer(instances, 0, frame.quads, 0, frame.count * quadFloats);
      if (failed) return;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.setVertexBuffer(0, instances);
      if (frame.count) pass.draw(6, frame.count);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    dispose() {
      instances?.destroy();
      texture.destroy();
      uniforms.destroy();
      device.destroy();
    },
  };
}
