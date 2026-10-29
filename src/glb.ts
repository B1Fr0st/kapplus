import type { MeshAsset } from "./types.js";

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: unknown;
}

interface GltfBufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}

interface GltfMesh {
  primitives: GltfPrimitive[];
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfDocument {
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
}

interface DecodedAccessor {
  values: number[];
  count: number;
  components: number;
  componentType: number;
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const COMPONENT_BYTES = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);
const COMPONENT_COUNTS = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(first: number[], second: number[]): number[] {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let inner = 0; inner < 4; inner++) {
        value += first[inner * 4 + row]! * second[column * 4 + inner]!;
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}

function compose(node: GltfNode): number[] {
  if (node.matrix) {
    if (node.matrix.length !== 16) throw new Error("GLB node matrix must contain 16 values");
    return node.matrix;
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [scaleX, scaleY, scaleZ] = node.scale ?? [1, 1, 1];
  const [translateX, translateY, translateZ] = node.translation ?? [0, 0, 0];
  const x2 = x! + x!;
  const y2 = y! + y!;
  const z2 = z! + z!;
  const xx = x! * x2;
  const xy = x! * y2;
  const xz = x! * z2;
  const yy = y! * y2;
  const yz = y! * z2;
  const zz = z! * z2;
  const wx = w! * x2;
  const wy = w! * y2;
  const wz = w! * z2;
  return [
    (1 - (yy + zz)) * scaleX!, (xy + wz) * scaleX!, (xz - wy) * scaleX!, 0,
    (xy - wz) * scaleY!, (1 - (xx + zz)) * scaleY!, (yz + wx) * scaleY!, 0,
    (xz + wy) * scaleZ!, (yz - wx) * scaleZ!, (1 - (xx + yy)) * scaleZ!, 0,
    translateX!, translateY!, translateZ!, 1,
  ];
}

function transformPoint(matrix: number[], x: number, y: number, z: number): number[] {
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
}

function normalize(x: number, y: number, z: number): number[] {
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? [x / length, y / length, z / length] : [0, 0, 1];
}

function transformNormal(matrix: number[], x: number, y: number, z: number): number[] {
  // The cofactor matrix is the inverse-transpose up to a shared determinant.
  // Preserve the determinant sign so mirrored nodes retain correct winding.
  const c00 = matrix[5]! * matrix[10]! - matrix[9]! * matrix[6]!;
  const c01 = matrix[9]! * matrix[2]! - matrix[1]! * matrix[10]!;
  const c02 = matrix[1]! * matrix[6]! - matrix[5]! * matrix[2]!;
  const c10 = matrix[8]! * matrix[6]! - matrix[4]! * matrix[10]!;
  const c11 = matrix[0]! * matrix[10]! - matrix[8]! * matrix[2]!;
  const c12 = matrix[4]! * matrix[2]! - matrix[0]! * matrix[6]!;
  const c20 = matrix[4]! * matrix[9]! - matrix[8]! * matrix[5]!;
  const c21 = matrix[8]! * matrix[1]! - matrix[0]! * matrix[9]!;
  const c22 = matrix[0]! * matrix[5]! - matrix[4]! * matrix[1]!;
  const determinant = matrix[0]! * c00 + matrix[4]! * c01 + matrix[8]! * c02;
  const sign = determinant < 0 ? -1 : 1;
  return normalize(
    sign * (c00 * x + c01 * y + c02 * z),
    sign * (c10 * x + c11 * y + c12 * z),
    sign * (c20 * x + c21 * y + c22 * z),
  );
}

function readComponent(view: DataView, offset: number, type: number): number {
  if (type === 5120) return view.getInt8(offset);
  if (type === 5121) return view.getUint8(offset);
  if (type === 5122) return view.getInt16(offset, true);
  if (type === 5123) return view.getUint16(offset, true);
  if (type === 5125) return view.getUint32(offset, true);
  if (type === 5126) return view.getFloat32(offset, true);
  throw new Error(`Unsupported GLB component type ${type}`);
}

function normalizedComponent(value: number, type: number): number {
  if (type === 5120) return Math.max(-1, value / 127);
  if (type === 5121) return value / 255;
  if (type === 5122) return Math.max(-1, value / 32767);
  if (type === 5123) return value / 65535;
  if (type === 5125) return value / 4294967295;
  return value;
}

function decodeAccessor(
  document: GltfDocument,
  binary: Buffer,
  accessorIndex: number,
): DecodedAccessor {
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`GLB references missing accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error("Sparse GLB accessors are not supported yet");
  const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
  const components = COMPONENT_COUNTS.get(accessor.type);
  if (!componentBytes || !components || !Number.isInteger(accessor.count) || accessor.count < 0) {
    throw new Error(`Unsupported GLB accessor ${accessorIndex}`);
  }
  if (accessor.bufferView === undefined) {
    return {
      values: new Array<number>(accessor.count * components).fill(0),
      count: accessor.count,
      components,
      componentType: accessor.componentType,
    };
  }
  const bufferView = document.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`GLB references missing buffer view ${accessor.bufferView}`);
  if ((bufferView.buffer ?? 0) !== 0) throw new Error("GLB meshes must use the embedded binary buffer");
  const elementBytes = componentBytes * components;
  const stride = bufferView.byteStride ?? elementBytes;
  if (stride < elementBytes) throw new Error(`Invalid GLB byte stride in accessor ${accessorIndex}`);
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = start + Math.max(0, accessor.count - 1) * stride + elementBytes;
  if (start < 0 || end > binary.length) throw new Error(`GLB accessor ${accessorIndex} exceeds its buffer`);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const values = new Array<number>(accessor.count * components);
  for (let element = 0; element < accessor.count; element++) {
    for (let component = 0; component < components; component++) {
      let value = readComponent(
        view,
        start + element * stride + component * componentBytes,
        accessor.componentType,
      );
      if (accessor.normalized) value = normalizedComponent(value, accessor.componentType);
      values[element * components + component] = value;
    }
  }
  return { values, count: accessor.count, components, componentType: accessor.componentType };
}

function computedNormals(vertices: number[], indices: number[]): number[] {
  const normals = new Array<number>(vertices.length).fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const first = indices[index]! * 3;
    const second = indices[index + 1]! * 3;
    const third = indices[index + 2]! * 3;
    const edgeAX = vertices[second]! - vertices[first]!;
    const edgeAY = vertices[second + 1]! - vertices[first + 1]!;
    const edgeAZ = vertices[second + 2]! - vertices[first + 2]!;
    const edgeBX = vertices[third]! - vertices[first]!;
    const edgeBY = vertices[third + 1]! - vertices[first + 1]!;
    const edgeBZ = vertices[third + 2]! - vertices[first + 2]!;
    const cross = [
      edgeAY * edgeBZ - edgeAZ * edgeBY,
      edgeAZ * edgeBX - edgeAX * edgeBZ,
      edgeAX * edgeBY - edgeAY * edgeBX,
    ];
    for (const offset of [first, second, third]) {
      normals[offset] = normals[offset]! + cross[0]!;
      normals[offset + 1] = normals[offset + 1]! + cross[1]!;
      normals[offset + 2] = normals[offset + 2]! + cross[2]!;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const normal = normalize(normals[offset]!, normals[offset + 1]!, normals[offset + 2]!);
    normals[offset] = normal[0]!;
    normals[offset + 1] = normal[1]!;
    normals[offset + 2] = normal[2]!;
  }
  return normals;
}

function parseChunks(sourcePath: string, buffer: Buffer): { document: GltfDocument; binary: Buffer } {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`Invalid GLB header: ${sourcePath}`);
  }
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  if (version !== 2) throw new Error(`KAP+ supports GLB version 2, received version ${version}`);
  if (declaredLength !== buffer.length) throw new Error(`GLB length header is invalid: ${sourcePath}`);
  let json: Buffer | undefined;
  let binary: Buffer | undefined;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error(`GLB chunk exceeds file length: ${sourcePath}`);
    if (type === JSON_CHUNK && !json) json = buffer.subarray(start, end);
    if (type === BINARY_CHUNK && !binary) binary = buffer.subarray(start, end);
    offset = end;
  }
  if (!json || !binary) throw new Error(`GLB must contain JSON and binary chunks: ${sourcePath}`);
  let document: GltfDocument;
  try {
    document = JSON.parse(json.toString("utf8").replace(/[\u0000 ]+$/, "")) as GltfDocument;
  } catch (error) {
    throw new Error(`Could not parse GLB JSON: ${(error as Error).message}`);
  }
  return { document, binary };
}

export function parseGlb(name: string, sourcePath: string, buffer: Buffer): MeshAsset {
  const { document, binary } = parseChunks(sourcePath, buffer);
  if (!document.meshes?.length) throw new Error(`GLB contains no meshes: ${sourcePath}`);
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const triangleMaterials: number[] = [];

  const appendMesh = (meshIndex: number, matrix: number[]): void => {
    const mesh = document.meshes?.[meshIndex];
    if (!mesh) throw new Error(`GLB references missing mesh ${meshIndex}`);
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) {
        throw new Error("Draco-compressed GLB meshes are not supported yet");
      }
      if (primitive.mode !== undefined && primitive.mode !== 4) {
        throw new Error(`GLB primitive mode ${primitive.mode} is unsupported; use triangles`);
      }
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex === undefined) throw new Error("GLB mesh primitive is missing POSITION");
      const position = decodeAccessor(document, binary, positionIndex);
      if (position.components !== 3) throw new Error("GLB POSITION accessors must use VEC3");
      const normal = primitive.attributes.NORMAL === undefined
        ? undefined
        : decodeAccessor(document, binary, primitive.attributes.NORMAL);
      if (normal && (normal.components !== 3 || normal.count !== position.count)) {
        throw new Error("GLB NORMAL accessor does not match POSITION");
      }
      const uv = primitive.attributes.TEXCOORD_0 === undefined
        ? undefined
        : decodeAccessor(document, binary, primitive.attributes.TEXCOORD_0);
      if (uv && (uv.components !== 2 || uv.count !== position.count)) {
        throw new Error("GLB TEXCOORD_0 accessor does not match POSITION");
      }
      const sourceIndices = primitive.indices === undefined
        ? Array.from({ length: position.count }, (_, index) => index)
        : (() => {
            const decoded = decodeAccessor(document, binary, primitive.indices!);
            if (decoded.components !== 1 || ![5121, 5123, 5125].includes(decoded.componentType)) {
              throw new Error("GLB indices must use an unsigned integer SCALAR accessor");
            }
            return decoded.values;
          })();
      if (sourceIndices.length % 3 !== 0) throw new Error("GLB triangle indices are incomplete");
      const vertexOffset = vertices.length / 3;
      const primitiveVertices: number[] = [];
      for (let vertex = 0; vertex < position.count; vertex++) {
        const offset = vertex * 3;
        const transformed = transformPoint(
          matrix,
          position.values[offset]!,
          position.values[offset + 1]!,
          position.values[offset + 2]!,
        );
        primitiveVertices.push(...transformed);
      }
      const numericIndices = sourceIndices.map((value) => {
        if (!Number.isInteger(value) || value < 0 || value >= position.count) {
          throw new Error(`GLB mesh contains invalid vertex index ${value}`);
        }
        return value;
      });
      const primitiveNormals = normal
        ? Array.from({ length: normal.count }, (_, vertex) => {
            const offset = vertex * 3;
            return transformNormal(
              matrix,
              normal.values[offset]!,
              normal.values[offset + 1]!,
              normal.values[offset + 2]!,
            );
          }).flat()
        : computedNormals(primitiveVertices, numericIndices);
      for (let component = 0; component < primitiveVertices.length; component++) {
        vertices.push(primitiveVertices[component]!);
        normals.push(primitiveNormals[component]!);
      }
      for (let vertex = 0; vertex < position.count; vertex++) {
        uvs.push(uv?.values[vertex * 2] ?? 0, uv?.values[vertex * 2 + 1] ?? 0);
      }
      for (const index of numericIndices) indices.push(index + vertexOffset);
      for (let triangle = 0; triangle < numericIndices.length / 3; triangle++) {
        triangleMaterials.push(primitive.material ?? 0);
      }
    }
  };

  const nodes = document.nodes ?? [];
  if (nodes.length === 0) {
    document.meshes.forEach((_, meshIndex) => appendMesh(meshIndex, identity()));
  } else {
    const childNodes = new Set(nodes.flatMap((node) => node.children ?? []));
    const activeScene = document.scenes?.[document.scene ?? 0];
    const roots = activeScene?.nodes?.length
      ? activeScene.nodes
      : nodes.map((_, index) => index).filter((index) => !childNodes.has(index));
    const visiting = new Set<number>();
    const visit = (nodeIndex: number, parent: number[]): void => {
      const node = nodes[nodeIndex];
      if (!node) throw new Error(`GLB references missing node ${nodeIndex}`);
      if (visiting.has(nodeIndex)) throw new Error("GLB scene graph contains a cycle");
      visiting.add(nodeIndex);
      const matrix = multiply(parent, compose(node));
      if (node.mesh !== undefined) appendMesh(node.mesh, matrix);
      for (const child of node.children ?? []) visit(child, matrix);
      visiting.delete(nodeIndex);
    };
    for (const root of roots) visit(root, identity());
  }
  if (indices.length === 0) throw new Error(`GLB contains no triangle primitives: ${sourcePath}`);
  return { kind: "mesh", name, sourcePath, vertices, normals, uvs, indices, triangleMaterials };
}
