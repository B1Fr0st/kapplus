import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { build, formatMessages, type BuildFailure } from "esbuild";
import ts from "typescript";
import { loadAsset } from "./assets.js";
import type { KapPlusAsset, KapPlusManifest } from "./types.js";

// Lifecycle names are the interface between a bundled entry and ProcessingJS.
const CALLBACKS = new Set([
  "setup", "draw", "mouseClicked", "mouseDragged", "mouseMoved", "mouseOut",
  "mouseOver", "mousePressed", "mouseReleased", "mouseScrolled", "keyPressed",
  "keyReleased", "keyTyped", "touchCancel", "touchEnd", "touchMove", "touchStart",
]);

function exposeEntryCallbacks(source: string): string {
  const file = ts.createSourceFile("bundle.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const removals: Array<{ start: number; end: number }> = [];
  const bindings: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const binding of statement.exportClause.elements) {
        const exported = binding.name.text;
        if (exported === "default") {
          throw new Error("The sketch entry uses named ProcessingJS callbacks (export function draw/setup), rather than a default export.");
        }
        const local = binding.propertyName?.text || exported;
        if (CALLBACKS.has(exported) && local !== exported) bindings.push(`var ${exported} = ${local};`);
      }
    }
    removals.push({ start: statement.getStart(file), end: statement.end });
  }
  for (const removal of removals.reverse()) source = source.slice(0, removal.start) + source.slice(removal.end);
  return source + "\n" + bindings.join("\n");
}

export async function bundleProject(entryPath: string, manifest: KapPlusManifest): Promise<{
  source: string;
  sourceWithoutImports: string;
  assets: KapPlusAsset[];
  inputFiles: string[];
}> {
  const source = await fs.readFile(entryPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`KAP+ entry file not found: ${entryPath}`);
    throw error;
  });
  const projectRoot = await fs.realpath(path.dirname(entryPath));
  const assets = new Map<string, { name: string; data: Promise<KapPlusAsset> }>();
  try {
    const result = await build({
      absWorkingDir: projectRoot,
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2015", // TypeScript subsequently lowers the flattened bundle to ES5.
      charset: "utf8",
      metafile: true,
      logLevel: "silent",
      legalComments: "inline",
      plugins: [{
        name: "kapplus-assets",
        setup(builder) {
          builder.onResolve({ filter: /\.(obj|glb|png|mp3)$/i }, async args => {
            if (args.pluginData?.kapplusResolve) return;
            const resolved = await builder.resolve(args.path, {
              kind: args.kind, resolveDir: args.resolveDir,
              pluginData: { kapplusResolve: true },
            });
            if (resolved.errors.length) return { errors: resolved.errors };
            if (!assets.has(resolved.path)) {
              const relative = path.relative(projectRoot, resolved.path).split(path.sep).join("/");
              const name = `__kapplus_asset_${crypto.createHash("sha256").update(relative).digest("hex").slice(0, 16)}`;
              const settings = manifest.assets;
              const data = loadAsset(name, resolved.path, settings.maxTextureSize,
                settings.audioQuality, settings.textureQuality, settings.maxMeshTriangles);
              // Resolution may run ahead of onLoad; retain failures until onLoad reports them.
              data.catch(() => {});
              assets.set(resolved.path, { name, data });
            }
            return { path: resolved.path, namespace: "kapplus-asset" };
          });
          builder.onLoad({ filter: /.*/, namespace: "kapplus-asset" }, async args => {
            const asset = assets.get(args.path)!;
            await asset.data;
            return { contents: `export default ${asset.name};`, loader: "js", watchFiles: [args.path] };
          });
        },
      }],
    });
    const inputFiles = [...new Set(await Promise.all([
      ...Object.keys(result.metafile!.inputs)
        .filter(file => !file.startsWith("kapplus-asset:"))
        .map(file => path.resolve(projectRoot, file)),
      ...assets.keys(),
    ].map(file => fs.realpath(file))))];
    return {
      source,
      sourceWithoutImports: exposeEntryCallbacks(result.outputFiles[0]!.text),
      assets: await Promise.all([...assets.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, asset]) => asset.data)),
      inputFiles,
    };
  } catch (error) {
    const failure = error as BuildFailure;
    if (!failure.errors) throw error;
    const messages = await formatMessages(failure.errors, { kind: "error", color: false });
    throw new Error(`Could not bundle ${entryPath}:\n${messages.join("\n")}`);
  }
}
