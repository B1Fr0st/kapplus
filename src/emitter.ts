import path from "node:path";
import type {
  AudioAsset,
  KapPlusAsset,
  KapPlusManifest,
  KapPlusTarget,
  MeshAsset,
  TextureAsset,
} from "./types.js";
import { runtimeFor } from "./runtime.js";

const BASE85_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function chunkString(value: string, size = 12_000): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(JSON.stringify(value.slice(offset, offset + size)));
  }
  return chunks.join(" +\n    ") || '""';
}

export function encodeFloat32(values: number[]): string {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index++) bytes.writeFloatLE(values[index]!, index * 4);
  return bytes.toString("base64");
}

export function encodeNormal8(values: number[]): string {
  const bytes = Buffer.allocUnsafe(values.length);
  for (let index = 0; index < values.length; index++) {
    bytes.writeInt8(Math.max(-127, Math.min(127, Math.round(values[index]! * 127))), index);
  }
  return bytes.toString("base64");
}

export function encodeIndices(values: number[]): { encoding: string; data: string } {
  if (values.every((value, index) => value === index)) {
    return { encoding: "sequence", data: "" };
  }
  const useUint16 = values.every((value) => value >= 0 && value <= 0xffff);
  const bytes = Buffer.allocUnsafe(values.length * (useUint16 ? 2 : 4));
  for (let index = 0; index < values.length; index++) {
    if (useUint16) bytes.writeUInt16LE(values[index]!, index * 2);
    else bytes.writeUInt32LE(values[index]!, index * 4);
  }
  return { encoding: useUint16 ? "u16" : "u32", data: bytes.toString("base64") };
}

function emitMesh(asset: MeshAsset): string {
  const uvIsZero = asset.uvs.every((value) => value === 0);
  const indices = encodeIndices(asset.indices);
  const materials = encodeIndices(asset.triangleMaterials);
  return `var ${asset.name} = KAPPlus.mesh(({` +
    `kind:"mesh",` +
    `vertexData:${chunkString(encodeFloat32(asset.vertices))},` +
    `vertexValueCount:${asset.vertices.length},` +
    `normalData:${chunkString(encodeNormal8(asset.normals))},` +
    `normalValueCount:${asset.normals.length},` +
    `uvEncoding:"${uvIsZero ? "zero" : "f32"}",` +
    `uvData:${chunkString(uvIsZero ? "" : encodeFloat32(asset.uvs))},` +
    `uvValueCount:${asset.uvs.length},` +
    `indexEncoding:"${indices.encoding}",` +
    `indexData:${chunkString(indices.data)},` +
    `indexCount:${asset.indices.length},` +
    `materialEncoding:"${materials.encoding}",` +
    `materialData:${chunkString(materials.data)},` +
    `materialCount:${asset.triangleMaterials.length}` +
    `}));`;
}

export function encodeTextureRaw(pixels: number[]): Buffer {
  const bytes = Buffer.allocUnsafe(pixels.length * 2);
  for (let index = 0; index < pixels.length; index++) bytes.writeUInt16LE(pixels[index]!, index * 2);
  return bytes;
}

export function encodeTextureRle(pixels: number[]): Buffer {
  const output: number[] = [];
  let index = 0;
  while (index < pixels.length) {
    let run = 1;
    while (run < 128 && index + run < pixels.length && pixels[index + run] === pixels[index]) run++;
    if (run >= 3) {
      output.push(127 + run, pixels[index]! & 255, pixels[index]! >>> 8);
      index += run;
      continue;
    }
    const literalStart = index;
    index += run;
    while (index < pixels.length && index - literalStart < 128) {
      run = 1;
      while (run < 3 && index + run < pixels.length && pixels[index + run] === pixels[index]) run++;
      if (run >= 3) break;
      const remaining = 128 - (index - literalStart);
      index += Math.min(run, remaining);
      if (run > remaining) break;
    }
    const count = index - literalStart;
    output.push(count - 1);
    for (let pixel = literalStart; pixel < index; pixel++) {
      output.push(pixels[pixel]! & 255, pixels[pixel]! >>> 8);
    }
  }
  return Buffer.from(output);
}

export function encodeTextureRaw32(pixels: number[]): Buffer {
  const bytes = Buffer.allocUnsafe(pixels.length * 4);
  for (let index = 0; index < pixels.length; index++) {
    bytes.writeUInt32LE(pixels[index]!, index * 4);
  }
  return bytes;
}

export function encodeTextureRle32(pixels: number[]): Buffer {
  const output: number[] = [];
  let index = 0;
  const appendPixel = (pixel: number): void => {
    output.push(pixel & 255, (pixel >>> 8) & 255, (pixel >>> 16) & 255, pixel >>> 24);
  };
  while (index < pixels.length) {
    let run = 1;
    while (run < 128 && index + run < pixels.length && pixels[index + run] === pixels[index]) run++;
    if (run >= 3) {
      output.push(127 + run);
      appendPixel(pixels[index]!);
      index += run;
      continue;
    }
    const literalStart = index;
    index += run;
    while (index < pixels.length && index - literalStart < 128) {
      run = 1;
      while (run < 3 && index + run < pixels.length && pixels[index + run] === pixels[index]) run++;
      if (run >= 3) break;
      const remaining = 128 - (index - literalStart);
      index += Math.min(run, remaining);
      if (run > remaining) break;
    }
    output.push(index - literalStart - 1);
    for (let pixel = literalStart; pixel < index; pixel++) appendPixel(pixels[pixel]!);
  }
  return Buffer.from(output);
}

function emitTexture(asset: TextureAsset): string {
  if (asset.sourceBytes) {
    return `var ${asset.name} = KAPPlus.texture(({` +
      `kind:"texture",name:${JSON.stringify(asset.name)},width:${asset.width},height:${asset.height},` +
      `pixelFormat:"rgba8888",filter:"linear",sourceEncoding:"png",` +
      `sourceData:${chunkString(asset.sourceBytes.toString("base64"))}` +
      `}));`;
  }
  const rgba = asset.pixelFormat === "rgba8888";
  const raw = rgba ? encodeTextureRaw32(asset.pixels) : encodeTextureRaw(asset.pixels);
  const rle = rgba ? encodeTextureRle32(asset.pixels) : encodeTextureRle(asset.pixels);
  const encoding = rle.length < raw.length
    ? (rgba ? "rle32" : "rle16")
    : (rgba ? "u32" : "u16");
  const data = (encoding.startsWith("rle") ? rle : raw).toString("base64");
  return `var ${asset.name} = KAPPlus.texture(({` +
    `kind:"texture",width:${asset.width},height:${asset.height},` +
    `pixelFormat:"${asset.pixelFormat}",filter:"${asset.filter}",` +
    `pixelEncoding:"${encoding}",pixelData:${chunkString(data)},pixelCount:${asset.pixels.length}` +
    `}));`;
}

export function encodeBase85(bytes: Buffer): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value = 0;
    for (let byte = 0; byte < 4; byte++) value = value * 256 + (bytes[offset + byte] ?? 0);
    const encoded = new Array<string>(5);
    for (let digit = 4; digit >= 0; digit--) {
      encoded[digit] = BASE85_ALPHABET[value % 85]!;
      value = Math.floor(value / 85);
    }
    result += encoded.join("");
  }
  return result;
}

function emitAudio(asset: AudioAsset): string {
  return `var ${asset.name} = KAPPlus.audio(\n    ${chunkString(encodeBase85(asset.bytes))},\n` +
    `    ${asset.bytes.length}\n);`;
}

export function emitAsset(asset: KapPlusAsset): string {
  if (asset.kind === "mesh") return emitMesh(asset);
  if (asset.kind === "texture") return emitTexture(asset);
  return emitAudio(asset);
}

export function emitProgram(
  target: KapPlusTarget,
  manifest: KapPlusManifest,
  source: string,
  assets: KapPlusAsset[],
): string {
  const assetSource = assets.map(emitAsset).join("\n\n");
  const waitsForTextures = assets.some(
    (asset) => asset.kind === "texture" && asset.sourceBytes,
  );
  const runSetup = waitsForTextures
    ? "KAPPlus.whenReady(function() { if (kapplusSourceSetup) { kapplusSourceSetup(); } });"
    : "if (kapplusSourceSetup) { kapplusSourceSetup(); }";
  const deferredSetup = `var kapplusSourceSetup = typeof setup === "function" ? setup : null;\n` +
    `setup = function() { size(${manifest.canvas.width}, ${manifest.canvas.height}); ${runSetup} };`;
  return [
    `// Generated by KAP+ for ${target}.`,
    `// Project: ${manifest.name}; assets: ${assets.length}.`,
    runtimeFor(target, assets.some((asset) => asset.kind === "audio")),
    assetSource,
    source,
    deferredSetup,
    "",
  ].join("\n");
}

export function emitLocalHtml(manifest: KapPlusManifest, program: string): string {
  const safeProgram = program.replaceAll("</script", "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${manifest.name} — KAP+ Preview</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: #111722; color: #eef2f7; }
    body { display: grid; place-items: center; font: 14px system-ui, sans-serif; }
    main { display: grid; gap: 12px; justify-items: center; }
    canvas { background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
    p { margin: 0; color: #9aa8ba; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/processing-js@1.6.6/processing.min.js"></script>
</head>
<body>
  <main>
    <canvas id="kapplus-canvas" width="${manifest.canvas.width}" height="${manifest.canvas.height}"></canvas>
    <p>KAP+ local preview · ${path.basename(manifest.entry)}</p>
  </main>
  <script type="application/processing" data-processing-target="kapplus-canvas">
${safeProgram}
  </script>
</body>
</html>
`;
}
