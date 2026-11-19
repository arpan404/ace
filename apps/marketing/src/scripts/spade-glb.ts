import * as z from "zod/mini";

/*
 * Reads public/spade.glb (blender/spade.py): one flat list of named meshes, each one primitive
 * with positions and indices and a material's base colour and roughness. That is all the GLB
 * carries and all the renderer needs, so this reads only that, not glTF at large.
 */

export interface SpadeMesh {
  name: string;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Linear RGB. */
  colour: [number, number, number];
  roughness: number;
  /** The middle of the mesh's bounds. */
  centre: [number, number, number];
}

const optionalNumber = z.optional(z.number());

const accessorSchema = z.object({
  bufferView: z.number(),
  byteOffset: optionalNumber,
  componentType: z.number(),
  count: z.number(),
  min: z.optional(z.array(z.number())),
  max: z.optional(z.array(z.number())),
});

const gltfSchema = z.object({
  nodes: z.array(z.object({ name: z.optional(z.string()), mesh: optionalNumber })),
  meshes: z.array(
    z.object({
      primitives: z
        .array(
          z.object({
            attributes: z.object({ POSITION: z.number() }),
            indices: z.number(),
            material: optionalNumber,
          }),
        )
        .check(z.minLength(1)),
    }),
  ),
  accessors: z.array(accessorSchema),
  bufferViews: z.array(z.object({ byteOffset: optionalNumber, byteLength: z.number() })),
  materials: z.optional(
    z.array(
      z.object({
        pbrMetallicRoughness: z.optional(
          z.object({
            baseColorFactor: z.optional(z.array(z.number())),
            roughnessFactor: optionalNumber,
          }),
        ),
      }),
    ),
  ),
});

const glbMagic = 0x46546c67;
const jsonChunk = 0x4e4f534a;
const binChunk = 0x004e4942;
const uint16 = 5123;
const uint32 = 5125;
const float32 = 5126;

export function readSpadeGlb(buffer: ArrayBuffer): SpadeMesh[] {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== glbMagic) throw new Error("not a GLB");
  let offset = 12;
  let json: unknown;
  let bin: ArrayBuffer | undefined;
  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = buffer.slice(offset + 8, offset + 8 + length);
    if (type === jsonChunk) json = JSON.parse(new TextDecoder().decode(body));
    if (type === binChunk) bin = body;
    offset += 8 + length;
  }
  if (!bin) throw new Error("GLB without a binary chunk");
  const gltf = gltfSchema.parse(json);
  const data = bin;

  const bytesOf = (index: number, size: number) => {
    const accessor = gltf.accessors[index];
    const bufferView = accessor && gltf.bufferViews[accessor.bufferView];
    if (!accessor || !bufferView) throw new Error(`missing accessor ${index}`);
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return { accessor, bytes: data.slice(start, start + accessor.count * size) };
  };

  return gltf.nodes.flatMap((node) => {
    const primitive = node.mesh === undefined ? undefined : gltf.meshes[node.mesh]?.primitives[0];
    if (!primitive || !node.name) return [];
    const position = bytesOf(primitive.attributes.POSITION, 12);
    if (position.accessor.componentType !== float32) throw new Error("positions must be floats");
    const index = gltf.accessors[primitive.indices];
    const wide = index?.componentType === uint32;
    if (!wide && index?.componentType !== uint16) throw new Error("unsupported index type");
    const indices = bytesOf(primitive.indices, wide ? 4 : 2).bytes;
    const material = gltf.materials?.[primitive.material ?? -1]?.pbrMetallicRoughness;
    const [r = 1, g = 1, b = 1] = material?.baseColorFactor ?? [];
    const min = position.accessor.min ?? [0, 0, 0];
    const max = position.accessor.max ?? [0, 0, 0];
    const mid = (axis: number) => ((min[axis] ?? 0) + (max[axis] ?? 0)) / 2;
    return [
      {
        name: node.name,
        positions: new Float32Array(position.bytes),
        indices: wide ? new Uint32Array(indices) : new Uint16Array(indices),
        colour: [r, g, b],
        roughness: material?.roughnessFactor ?? 1,
        centre: [mid(0), mid(1), mid(2)],
      },
    ];
  });
}
