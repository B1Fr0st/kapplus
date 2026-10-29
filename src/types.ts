export type KapPlusTarget = "local" | "khan";

export interface KapPlusManifest {
  name: string;
  entry: string;
  outDir: string;
  canvas: { width: number; height: number };
  assets: {
    maxTextureSize: number;
    maxMeshTriangles: number;
    textureQuality: "compact" | "high" | "source";
    maxBundleBytes: number;
    audioQuality: "compact" | "source";
  };
  publish?: {
    repository: string;
    branch: string;
    chunks: number | "auto";
  };
}

export interface MeshAsset {
  kind: "mesh";
  name: string;
  sourcePath: string;
  vertices: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  triangleMaterials: number[];
}

export interface TextureAsset {
  kind: "texture";
  name: string;
  sourcePath: string;
  width: number;
  height: number;
  pixelFormat: "rgb5551" | "rgba8888";
  filter: "nearest" | "linear";
  pixels: number[];
  sourceBytes?: Buffer;
}

export interface AudioAsset {
  kind: "audio";
  name: string;
  sourcePath: string;
  bytes: Buffer;
  originalByteLength?: number;
  optimizedBitrateKbps?: number;
}

export type KapPlusAsset = MeshAsset | TextureAsset | AudioAsset;

export interface ProjectAnalysis {
  manifestPath: string;
  rootDir: string;
  manifest: KapPlusManifest;
  source: string;
  sourceWithoutImports: string;
  assets: KapPlusAsset[];
  inputFiles: string[];
}

export interface BuildResult {
  localProgram: string;
  localHtml: string;
  khanProgram: string;
  assets: KapPlusAsset[];
}
