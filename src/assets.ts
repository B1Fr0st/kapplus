import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";
import type { AudioAsset, KapPlusAsset, MeshAsset, TextureAsset } from "./types.js";
import { parseGlb } from "./glb.js";

interface AssetImport {
  name: string;
  specifier: string;
  start: number;
  end: number;
}

const ASSET_IMPORT = /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"']+)\2\s*;?\s*$/gm;
const AUDIO_OPTIMIZE_THRESHOLD_BYTES = 1_000_000;
const AUDIO_TARGET_BYTES = 800_000;
const AUDIO_BITRATES_KBPS = [48, 32, 24, 16];

export function findAssetImports(source: string): AssetImport[] {
  const imports: AssetImport[] = [];
  for (const match of source.matchAll(ASSET_IMPORT)) {
    imports.push({
      name: match[1]!,
      specifier: match[3]!,
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }
  return imports;
}

export function removeAssetImports(source: string, imports: AssetImport[]): string {
  let result = source;
  for (const assetImport of [...imports].reverse()) {
    result = result.slice(0, assetImport.start) + result.slice(assetImport.end);
  }
  return result.trimStart();
}

function parseIndex(value: string, length: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed === 0) throw new Error(`Invalid OBJ index: ${value}`);
  return parsed < 0 ? length + parsed : parsed - 1;
}

function normalize(vector: number[]): number[] {
  const length = Math.hypot(vector[0]!, vector[1]!, vector[2]!);
  return length > 1e-12
    ? [vector[0]! / length, vector[1]! / length, vector[2]! / length]
    : [0, 0, 1];
}

function parseObj(name: string, sourcePath: string, source: string): MeshAsset {
  const positions: number[][] = [];
  const sourceNormals: number[][] = [];
  const sourceUvs: number[][] = [];
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const triangleMaterials: number[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      positions.push(parts.slice(1, 4).map(Number));
    } else if (parts[0] === "vn" && parts.length >= 4) {
      sourceNormals.push(normalize(parts.slice(1, 4).map(Number)));
    } else if (parts[0] === "vt" && parts.length >= 3) {
      sourceUvs.push(parts.slice(1, 3).map(Number));
    } else if (parts[0] === "f" && parts.length >= 4) {
      const corners = parts.slice(1).map((token) => {
        const fields = token.split("/");
        return {
          position: parseIndex(fields[0]!, positions.length),
          uv: fields[1] ? parseIndex(fields[1], sourceUvs.length) : -1,
          normal: fields[2] ? parseIndex(fields[2], sourceNormals.length) : -1,
        };
      });
      for (let corner = 1; corner < corners.length - 1; corner++) {
        const triangle = [corners[0]!, corners[corner]!, corners[corner + 1]!];
        const points = triangle.map((item) => positions[item.position]);
        if (points.some((point) => !point)) throw new Error("OBJ face references a missing vertex");
        const edgeA = points[1]!.map((value, axis) => value - points[0]![axis]!);
        const edgeB = points[2]!.map((value, axis) => value - points[0]![axis]!);
        const faceNormal = normalize([
          edgeA[1]! * edgeB[2]! - edgeA[2]! * edgeB[1]!,
          edgeA[2]! * edgeB[0]! - edgeA[0]! * edgeB[2]!,
          edgeA[0]! * edgeB[1]! - edgeA[1]! * edgeB[0]!,
        ]);
        for (const item of triangle) {
          const position = positions[item.position]!;
          const normal = item.normal >= 0 ? sourceNormals[item.normal] : faceNormal;
          const uv = item.uv >= 0 ? sourceUvs[item.uv] : [0, 0];
          if (!normal || !uv) throw new Error("OBJ face references missing normal or UV data");
          vertices.push(...position);
          normals.push(...normal);
          uvs.push(...uv);
          indices.push(indices.length);
        }
        triangleMaterials.push(0);
      }
    }
  }

  if (vertices.length === 0) throw new Error(`OBJ contains no triangles: ${sourcePath}`);
  return { kind: "mesh", name, sourcePath, vertices, normals, uvs, indices, triangleMaterials };
}

function paeth(a: number, b: number, c: number): number {
  const prediction = a + b - c;
  const pa = Math.abs(prediction - a);
  const pb = Math.abs(prediction - b);
  const pc = Math.abs(prediction - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buffer: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("Texture is not a PNG file");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const channelCounts: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelCounts[colorType];
  const supportsPacked = (colorType === 0 || colorType === 3) && [1, 2, 4, 8].includes(bitDepth);
  const supportsDirect = colorType !== 3 && bitDepth === 8;
  if (!width || !height || !channels || (!supportsPacked && !supportsDirect) || interlace !== 0) {
    throw new Error("KAP+ supports non-interlaced PNGs with 1/2/4/8-bit grayscale or palette data and 8-bit RGB/RGBA data");
  }
  if (colorType === 3 && (!palette || palette.length === 0 || palette.length % 3 !== 0)) {
    throw new Error("Indexed PNG texture is missing a valid palette");
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil(width * bitsPerPixel / 8);
  const filterBytes = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const decoded = new Uint8Array(stride * height);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[input++]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[input++]!;
      const left = x >= filterBytes ? decoded[y * stride + x - filterBytes]! : 0;
      const up = y > 0 ? decoded[(y - 1) * stride + x]! : 0;
      const upperLeft = y > 0 && x >= filterBytes
        ? decoded[(y - 1) * stride + x - filterBytes]!
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upperLeft)
                : -1;
      if (predictor < 0) throw new Error(`Unsupported PNG filter ${filter}`);
      decoded[y * stride + x] = (value + predictor) & 255;
    }
  }
  const packedSample = (pixel: number): number => {
    const y = Math.floor(pixel / width);
    const x = pixel - y * width;
    const bitOffset = x * bitDepth;
    const byte = decoded[y * stride + Math.floor(bitOffset / 8)]!;
    const shift = 8 - bitDepth - (bitOffset % 8);
    return (byte >>> shift) & ((1 << bitDepth) - 1);
  };
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = bitDepth === 8 ? pixel * channels : 0;
    const target = pixel * 4;
    if (colorType === 3) {
      const paletteIndex = packedSample(pixel);
      rgba[target] = palette![paletteIndex * 3] ?? 0;
      rgba[target + 1] = palette![paletteIndex * 3 + 1] ?? 0;
      rgba[target + 2] = palette![paletteIndex * 3 + 2] ?? 0;
      rgba[target + 3] = transparency?.[paletteIndex] ?? 255;
    } else if (colorType === 0 || colorType === 4) {
      const gray = bitDepth === 8
        ? decoded[source]!
        : Math.round(packedSample(pixel) * 255 / ((1 << bitDepth) - 1));
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = colorType === 4 ? decoded[source + 1]! : 255;
    } else {
      rgba[target] = decoded[source]!;
      rgba[target + 1] = decoded[source + 1]!;
      rgba[target + 2] = decoded[source + 2]!;
      rgba[target + 3] = colorType === 6 ? decoded[source + 3]! : 255;
    }
  }
  return { width, height, rgba };
}

function resizeAndPackTexture(
  name: string,
  sourcePath: string,
  decoded: ReturnType<typeof decodePng>,
  maxSize: number,
  quality: "compact" | "high" | "source",
): TextureAsset {
  const scale = quality === "source"
    ? 1
    : Math.min(1, maxSize / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const pixels: number[] = [];

  const sourcePixel = (targetX: number, targetY: number): [number, number, number, number] => {
    if (quality === "compact" || (width === decoded.width && height === decoded.height)) {
      const sourceX = Math.min(decoded.width - 1, Math.floor((targetX * decoded.width) / width));
      const sourceY = Math.min(decoded.height - 1, Math.floor((targetY * decoded.height) / height));
      const offset = (sourceY * decoded.width + sourceX) * 4;
      return [
        decoded.rgba[offset]!,
        decoded.rgba[offset + 1]!,
        decoded.rgba[offset + 2]!,
        decoded.rgba[offset + 3]!,
      ];
    }

    // Area resampling averages every source pixel covered by the destination
    // pixel. Colors are accumulated with premultiplied alpha to prevent dark
    // fringes around translucent PNG edges.
    const left = targetX * decoded.width / width;
    const right = (targetX + 1) * decoded.width / width;
    const top = targetY * decoded.height / height;
    const bottom = (targetY + 1) * decoded.height / height;
    var alphaWeight = 0;
    var totalWeight = 0;
    var red = 0;
    var green = 0;
    var blue = 0;
    for (let sourceY = Math.floor(top); sourceY < Math.ceil(bottom); sourceY++) {
      const yWeight = Math.min(bottom, sourceY + 1) - Math.max(top, sourceY);
      for (let sourceX = Math.floor(left); sourceX < Math.ceil(right); sourceX++) {
        const xWeight = Math.min(right, sourceX + 1) - Math.max(left, sourceX);
        const weight = xWeight * yWeight;
        const offset = (sourceY * decoded.width + sourceX) * 4;
        const alpha = decoded.rgba[offset + 3]! / 255;
        const colorWeight = weight * alpha;
        red += decoded.rgba[offset]! * colorWeight;
        green += decoded.rgba[offset + 1]! * colorWeight;
        blue += decoded.rgba[offset + 2]! * colorWeight;
        alphaWeight += colorWeight;
        totalWeight += weight;
      }
    }
    return [
      alphaWeight ? Math.round(red / alphaWeight) : 0,
      alphaWeight ? Math.round(green / alphaWeight) : 0,
      alphaWeight ? Math.round(blue / alphaWeight) : 0,
      totalWeight ? Math.round(alphaWeight / totalWeight * 255) : 0,
    ];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue, alpha] = sourcePixel(x, y);
      if (quality === "compact") {
        pixels.push(
          (alpha >= 128 ? 0x8000 : 0) |
            ((red >> 3) << 10) |
            ((green >> 3) << 5) |
            (blue >> 3),
        );
      } else {
        pixels.push(red * 0x1000000 + green * 0x10000 + blue * 0x100 + alpha);
      }
    }
  }
  return {
    kind: "texture",
    name,
    sourcePath,
    width,
    height,
    pixelFormat: quality === "compact" ? "rgb5551" : "rgba8888",
    filter: quality === "compact" ? "nearest" : "linear",
    pixels,
  };
}

function transcodeMp3(sourcePath: string, bitrateKbps: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const executable = process.env.KAPPLUS_FFMPEG || "ffmpeg";
    const child = spawn(
      executable,
      [
        "-v", "error",
        "-i", sourcePath,
        "-map_metadata", "-1",
        "-vn",
        "-ac", "1",
        "-ar", "24000",
        "-b:a", `${bitrateKbps}k`,
        "-f", "mp3",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Large MP3 assets require ffmpeg for Khan-safe compression. ` +
              `Install ffmpeg or set KAPPLUS_FFMPEG to its executable path: ${sourcePath}`,
          ),
        );
      } else reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        const bytes = Buffer.concat(output);
        if (bytes.length === 0) reject(new Error(`ffmpeg produced an empty MP3: ${sourcePath}`));
        else resolve(bytes);
        return;
      }
      const details = Buffer.concat(errors).toString("utf8").trim();
      reject(
        new Error(
          `Could not optimize MP3 ${sourcePath} with ffmpeg` +
            (details ? `:\n${details}` : ` (exit code ${code ?? "unknown"})`),
        ),
      );
    });
  });
}

async function loadAudioAsset(
  name: string,
  sourcePath: string,
  audioQuality: "compact" | "source",
): Promise<AudioAsset> {
  const original = await fs.readFile(sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Imported MP3 was not found: ${sourcePath}`);
    throw error;
  });
  if (original.length === 0) throw new Error(`MP3 is empty: ${sourcePath}`);
  if (audioQuality === "source" || original.length <= AUDIO_OPTIMIZE_THRESHOLD_BYTES) {
    return { kind: "audio", name, sourcePath, bytes: original };
  }

  let smallest: Buffer = original;
  let optimizedBitrateKbps: number | undefined;
  for (const bitrateKbps of AUDIO_BITRATES_KBPS) {
    const candidate = await transcodeMp3(sourcePath, bitrateKbps);
    if (candidate.length < smallest.length) {
      smallest = candidate;
      optimizedBitrateKbps = bitrateKbps;
    }
    if (smallest.length <= AUDIO_TARGET_BYTES) break;
  }
  return {
    kind: "audio",
    name,
    sourcePath,
    bytes: smallest,
    originalByteLength: original.length,
    optimizedBitrateKbps,
  };
}

function simplifyMesh(mesh: MeshAsset, maxTriangles: number): MeshAsset {
  if (mesh.indices.length / 3 <= maxTriangles) return mesh;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < mesh.vertices.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis]!, mesh.vertices[offset + axis]!);
      maximum[axis] = Math.max(maximum[axis]!, mesh.vertices[offset + axis]!);
    }
  }
  const longest = Math.max(
    maximum[0]! - minimum[0]!,
    maximum[1]! - minimum[1]!,
    maximum[2]! - minimum[2]!,
    1e-9,
  );
  const vertexMaterials = new Int32Array(mesh.vertices.length / 3);
  vertexMaterials.fill(-1);
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const material = mesh.triangleMaterials[offset / 3] ?? 0;
    vertexMaterials[mesh.indices[offset]!] = material;
    vertexMaterials[mesh.indices[offset + 1]!] = material;
    vertexMaterials[mesh.indices[offset + 2]!] = material;
  }

  const cluster = (resolution: number): MeshAsset => {
    const cells = new Map<string, number>();
    const sourceToCluster = new Int32Array(mesh.vertices.length / 3);
    const sums: number[][] = [];
    for (let vertex = 0; vertex < sourceToCluster.length; vertex++) {
      const offset = vertex * 3;
      const cellX = Math.round((mesh.vertices[offset]! - minimum[0]!) * resolution / longest);
      const cellY = Math.round((mesh.vertices[offset + 1]! - minimum[1]!) * resolution / longest);
      const cellZ = Math.round((mesh.vertices[offset + 2]! - minimum[2]!) * resolution / longest);
      // Keep coincident parts from different materials separate so reducing a
      // dense GLB cannot smear one texture atlas into another.
      const key = `${vertexMaterials[vertex]!}:${cellX},${cellY},${cellZ}`;
      let target = cells.get(key);
      if (target === undefined) {
        target = sums.length;
        cells.set(key, target);
        sums.push([0, 0, 0, 0, 0, 0, 0, 0, 0]);
      }
      sourceToCluster[vertex] = target;
      const sum = sums[target]!;
      sum[0] = sum[0]! + mesh.vertices[offset]!;
      sum[1] = sum[1]! + mesh.vertices[offset + 1]!;
      sum[2] = sum[2]! + mesh.vertices[offset + 2]!;
      sum[3] = sum[3]! + mesh.normals[offset]!;
      sum[4] = sum[4]! + mesh.normals[offset + 1]!;
      sum[5] = sum[5]! + mesh.normals[offset + 2]!;
      sum[6] = sum[6]! + mesh.uvs[vertex * 2]!;
      sum[7] = sum[7]! + mesh.uvs[vertex * 2 + 1]!;
      sum[8] = sum[8]! + 1;
    }

    const remapped: number[] = [];
    const triangleMaterials: number[] = [];
    const unique = new Set<string>();
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const first = sourceToCluster[mesh.indices[offset]!]!;
      const second = sourceToCluster[mesh.indices[offset + 1]!]!;
      const third = sourceToCluster[mesh.indices[offset + 2]!]!;
      if (first === second || second === third || first === third) continue;
      const material = mesh.triangleMaterials[offset / 3] ?? 0;
      const canonical = `${material}:${[first, second, third].sort((a, b) => a - b).join(",")}`;
      if (unique.has(canonical)) continue;
      unique.add(canonical);
      remapped.push(first, second, third);
      triangleMaterials.push(material);
    }

    const used = new Set(remapped);
    const compact = new Map<number, number>();
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (const oldIndex of used) {
      compact.set(oldIndex, compact.size);
      const sum = sums[oldIndex]!;
      const count = sum[8]!;
      vertices.push(sum[0]! / count, sum[1]! / count, sum[2]! / count);
      const normal = normalize([sum[3]!, sum[4]!, sum[5]!]);
      normals.push(...normal);
      uvs.push(sum[6]! / count, sum[7]! / count);
    }
    return {
      ...mesh,
      vertices,
      normals,
      uvs,
      indices: remapped.map((index) => compact.get(index)!),
      triangleMaterials,
    };
  };

  let low = 1;
  let high = 256;
  let best = cluster(low);
  while (low <= high) {
    const resolution = Math.floor((low + high) / 2);
    const candidate = cluster(resolution);
    if (candidate.indices.length / 3 <= maxTriangles) {
      best = candidate;
      low = resolution + 1;
    } else {
      high = resolution - 1;
    }
  }
  return best;
}

export async function loadAssets(
  entryPath: string,
  source: string,
  maxTextureSize: number,
  audioQuality: "compact" | "source" = "compact",
  textureQuality: "compact" | "high" | "source" = "compact",
  maxMeshTriangles = 25_000,
): Promise<{ sourceWithoutImports: string; assets: KapPlusAsset[] }> {
  const imports = findAssetImports(source);
  const names = new Set<string>();
  const assets: KapPlusAsset[] = [];
  for (const assetImport of imports) {
    if (names.has(assetImport.name)) throw new Error(`Duplicate asset name: ${assetImport.name}`);
    names.add(assetImport.name);
    const sourcePath = path.resolve(path.dirname(entryPath), assetImport.specifier);
    assets.push(await loadAsset(assetImport.name, sourcePath, maxTextureSize, audioQuality, textureQuality, maxMeshTriangles));
  }
  return { sourceWithoutImports: removeAssetImports(source, imports), assets };
}

export async function loadAsset(
  name: string,
  sourcePath: string,
  maxTextureSize: number,
  audioQuality: "compact" | "source" = "compact",
  textureQuality: "compact" | "high" | "source" = "compact",
  maxMeshTriangles = 25_000,
): Promise<KapPlusAsset> {
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension === ".obj") {
      return simplifyMesh(
        parseObj(name, sourcePath, await fs.readFile(sourcePath, "utf8")),
        maxMeshTriangles,
      );
    } else if (extension === ".glb") {
      return simplifyMesh(
        parseGlb(name, sourcePath, await fs.readFile(sourcePath)),
        maxMeshTriangles,
      );
    } else if (extension === ".png") {
      const bytes = await fs.readFile(sourcePath);
      if (textureQuality === "source") {
        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
          throw new Error(`Texture is not a PNG file: ${sourcePath}`);
        }
        return {
          kind: "texture",
          name,
          sourcePath,
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
          pixelFormat: "rgba8888",
          filter: "linear",
          pixels: [],
          sourceBytes: bytes,
        };
      } else {
        return resizeAndPackTexture(
            name,
            sourcePath,
            decodePng(bytes),
            maxTextureSize,
            textureQuality,
        );
      }
    } else if (extension === ".mp3") {
      return loadAudioAsset(name, sourcePath, audioQuality);
    } else {
      throw new Error(
        `Unsupported asset import ${sourcePath}; ` +
          `KAP+ currently supports .obj, .glb, .png, and .mp3`,
      );
    }
}
