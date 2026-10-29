import { describe, expect, it } from "vitest";
import {
  encodeBase85,
  encodeFloat32,
  encodeIndices,
  encodeNormal8,
  encodeTextureRaw,
  encodeTextureRaw32,
  encodeTextureRle,
  encodeTextureRle32,
} from "../src/emitter.js";

const base85Alphabet =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function decodeBase85(data: string, byteLength: number): Buffer {
  const output = Buffer.alloc(byteLength);
  let outputIndex = 0;
  for (let offset = 0; offset < data.length && outputIndex < byteLength; offset += 5) {
    let value = 0;
    for (let digit = 0; digit < 5; digit++) {
      value = value * 85 + base85Alphabet.indexOf(data[offset + digit]!);
    }
    for (const divisor of [16_777_216, 65_536, 256, 1]) {
      if (outputIndex < byteLength) output[outputIndex++] = Math.floor(value / divisor) % 256;
    }
  }
  return output;
}

function decodeRle16(bytes: Buffer, count: number): number[] {
  const result: number[] = [];
  let offset = 0;
  while (result.length < count) {
    const control = bytes[offset++]!;
    if (control < 128) {
      for (let index = 0; index < control + 1; index++) {
        result.push(bytes.readUInt16LE(offset));
        offset += 2;
      }
    } else {
      const run = control - 127;
      const pixel = bytes.readUInt16LE(offset);
      offset += 2;
      for (let index = 0; index < run; index++) result.push(pixel);
    }
  }
  return result;
}

function decodeRle32(bytes: Buffer, count: number): number[] {
  const result: number[] = [];
  let offset = 0;
  while (result.length < count) {
    const control = bytes[offset++]!;
    if (control < 128) {
      for (let index = 0; index < control + 1; index++) {
        result.push(bytes.readUInt32LE(offset));
        offset += 4;
      }
    } else {
      const run = control - 127;
      const pixel = bytes.readUInt32LE(offset);
      offset += 4;
      for (let index = 0; index < run; index++) result.push(pixel);
    }
  }
  return result;
}

describe("KAP+ asset codecs", () => {
  it("round-trips Z85 audio blocks including partial final groups", () => {
    for (let length = 0; length < 20; length++) {
      const input = Buffer.from(Array.from({ length }, (_, index) => (index * 53 + 19) & 255));
      expect(decodeBase85(encodeBase85(input), input.length)).toEqual(input);
    }
  });

  it("encodes mesh fields as Float32, normalized bytes, and implicit indices", () => {
    const floats = [0, -1.25, Math.PI, 1000.5];
    const floatBytes = Buffer.from(encodeFloat32(floats), "base64");
    expect(floats.map((_, index) => floatBytes.readFloatLE(index * 4)))
      .toEqual(floats.map(Math.fround));

    const normals = [-1, -0.5, 0, 0.5, 1];
    const normalBytes = Buffer.from(encodeNormal8(normals), "base64");
    const decoded = normals.map((_, index) => normalBytes.readInt8(index) / 127);
    decoded.forEach((value, index) => expect(value).toBeCloseTo(normals[index]!, 2));
    expect(encodeIndices([0, 1, 2, 3])).toEqual({ encoding: "sequence", data: "" });
  });

  it("round-trips raw and run-length encoded RGB5551 pixels", () => {
    const pixels = [0x8000, 0x8000, 0x8000, 0x1234, 0x4567, 0x4567, 0x4567, 0x4567];
    const raw = encodeTextureRaw(pixels);
    expect(pixels.map((_, index) => raw.readUInt16LE(index * 2))).toEqual(pixels);
    expect(decodeRle16(encodeTextureRle(pixels), pixels.length)).toEqual(pixels);
  });

  it("round-trips raw and run-length encoded RGBA8888 pixels", () => {
    const pixels = [0xff0080ff, 0xff0080ff, 0xff0080ff, 0x01020304, 0xfefdfcfb, 0xfefdfcfb];
    const raw = encodeTextureRaw32(pixels);
    expect(pixels.map((_, index) => raw.readUInt32LE(index * 4))).toEqual(pixels);
    expect(decodeRle32(encodeTextureRle32(pixels), pixels.length)).toEqual(pixels);
  });

  it("keeps RLE literal blocks aligned when a pair crosses the 128-pixel boundary", () => {
    const pixels16 = Array.from({ length: 127 }, (_, index) => index + 1).concat([
      500, 500, 501, 502, 503,
    ]);
    const pixels32 = pixels16.map((value) => value * 0x10001);
    expect(decodeRle16(encodeTextureRle(pixels16), pixels16.length)).toEqual(pixels16);
    expect(decodeRle32(encodeTextureRle32(pixels32), pixels32.length)).toEqual(pixels32);
  });
});
