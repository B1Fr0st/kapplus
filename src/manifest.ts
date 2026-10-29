import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { KapPlusManifest } from "./types.js";

const manifestSchema = z.object({
  name: z.string().min(1).default("kapplus-project"),
  entry: z.string().min(1),
  outDir: z.string().min(1).default("dist-kapplus"),
  canvas: z
    .object({
      width: z.number().int().min(1).max(2048).default(400),
      height: z.number().int().min(1).max(2048).default(400),
    })
    .default({ width: 400, height: 400 }),
  assets: z
    .object({
      maxTextureSize: z.number().int().min(1).max(8192).default(128),
      maxMeshTriangles: z.number().int().min(100).max(1_000_000).default(25_000),
      textureQuality: z.enum(["compact", "high", "source"]).default("compact"),
      maxBundleBytes: z.number().int().min(1024).default(2_000_000),
      audioQuality: z.enum(["compact", "source"]).default("compact"),
    })
    .default({
      maxTextureSize: 128,
      maxMeshTriangles: 25_000,
      textureQuality: "compact",
      maxBundleBytes: 2_000_000,
      audioQuality: "compact",
    }),
  publish: z
    .object({
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      branch: z.string().min(1).default("main"),
      chunks: z.union([z.literal("auto"), z.number().int().min(1).max(32)]).default("auto"),
    })
    .optional(),
});

export async function loadManifest(manifestPath: string): Promise<{
  manifestPath: string;
  rootDir: string;
  manifest: KapPlusManifest;
}> {
  const resolved = path.resolve(manifestPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`KAP+ manifest not found: ${resolved}`);
    }
    throw new Error(`Could not read KAP+ manifest ${resolved}: ${(error as Error).message}`);
  }

  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid KAP+ manifest:\n${details}`);
  }

  return { manifestPath: resolved, rootDir: path.dirname(resolved), manifest: result.data };
}
