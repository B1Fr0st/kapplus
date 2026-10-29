import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAssets } from "../src/assets.js";

const temporaryDirectories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-glb-"));
  temporaryDirectories.push(directory);
  return directory;
}

function pad(buffer: Buffer, fill = 0): Buffer {
  return Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4, fill)]);
}

function minimalGlb(): Buffer {
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(6);
  [0, 1, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const binary = pad(Buffer.concat([positions, indices]));
  const document = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0, translation: [2, 3, 4] }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = pad(Buffer.from(JSON.stringify(document)), 0x20);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  const binaryHeader = 20 + json.length;
  output.writeUInt32LE(binary.length, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("KAP+ GLB assets", () => {
  it("loads indexed GLB triangles, applies scene transforms, and computes normals", async () => {
    const directory = await makeDirectory();
    await fs.writeFile(path.join(directory, "model.glb"), minimalGlb());
    const entryPath = path.join(directory, "main.js");
    const source = 'import model from "./model.glb";\ndraw=function(){triangle(0,0,1,0,0,1);};';
    await fs.writeFile(entryPath, source);

    const loaded = await loadAssets(entryPath, source, 256, "source", "source");
    expect(loaded.sourceWithoutImports).not.toContain("import model");
    expect(loaded.assets).toHaveLength(1);
    const model = loaded.assets[0];
    expect(model?.kind).toBe("mesh");
    if (!model || model.kind !== "mesh") return;
    expect(model.vertices).toEqual([2, 3, 4, 3, 3, 4, 2, 4, 4]);
    expect(model.indices).toEqual([0, 1, 2]);
    expect(model.triangleMaterials).toEqual([0]);
    expect(model.normals).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(model.uvs).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
