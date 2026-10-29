import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { minify } from "terser";
import { bundleProject } from "./bundler.js";
import { emitLocalHtml, emitProgram } from "./emitter.js";
import { loadManifest } from "./manifest.js";
import type { BuildResult, ProjectAnalysis } from "./types.js";

// ProcessingJS discovers these callbacks by their global names. Most KAP+
// programs assign them as undeclared globals, but reserving and retaining the
// names also supports `var draw = ...` and `function setup() { ... }` authoring
// styles while allowing every other safe top-level binding to be mangled.
export const PROCESSING_CALLBACKS = [
  "setup",
  "draw",
  "mouseClicked",
  "mouseDragged",
  "mouseMoved",
  "mouseOut",
  "mouseOver",
  "mousePressed",
  "mouseReleased",
  "mouseScrolled",
  "keyPressed",
  "keyReleased",
  "keyTyped",
  "touchCancel",
  "touchEnd",
  "touchMove",
  "touchStart",
] as const;

// Khan rewrites catch clauses through its ProcessingJS environment object. A
// mangled catch binding can alias an outer binding there, so the chunk loader's
// diagnostic binding must retain a globally unique name.
const KHAN_MANGLE_RESERVED = [
  ...PROCESSING_CALLBACKS,
  "kapplusLoaderFailure",
  "joinLoaderWords",
  "loaderCarrier",
  "loaderDocument",
  "loaderWindow",
  "loaderGenerationKey",
  "loaderGeneration",
  "loaderIsCurrent",
  "loaderRegistryKey",
  "loaderBuildId",
  "loaderUrls",
  "loaderCallbacks",
  "loaderHandlers",
  "loaderInstance",
  "loaderScope",
  "loaderState",
  "loaderSetState",
  "loaderCompleted",
  "loaderStart",
  "loaderLoadNext",
  "loaderScreen",
  "loaderDispatch",
  "liveJoinWords",
  "liveCarrier",
  "liveDocument",
  "liveWindow",
  "liveGenerationKey",
  "liveGeneration",
  "liveIsCurrent",
  "liveRegistryKey",
  "liveBootstrapUrl",
  "liveBootstrapUrls",
  "liveCallbacks",
  "liveHandlers",
  "liveInstance",
  "liveScope",
  "liveState",
  "liveSetState",
  "liveBestBootstrap",
  "liveBestRelease",
  "liveBootstrapIndex",
  "liveStart",
  "liveLoadNext",
  "liveDispatch",
  "kapplusLiveFailure",
];

interface PrintedToken {
  kind: ts.SyntaxKind;
  text: string;
}

const whitespaceBoundaryCache = new Map<string, boolean>();

function canRemoveWhitespace(left: PrintedToken, right: PrintedToken): boolean {
  // Retain conventional keyword spacing for Khan's legacy parser even where
  // modern JavaScript permits forms such as `if(` or `return[1]`.
  if (
    (left.kind >= ts.SyntaxKind.FirstKeyword && left.kind <= ts.SyntaxKind.LastKeyword) ||
    (right.kind >= ts.SyntaxKind.FirstKeyword && right.kind <= ts.SyntaxKind.LastKeyword)
  ) {
    return false;
  }
  const cacheKey = `${left.kind}:${left.text}\0${right.kind}:${right.text}`;
  const cached = whitespaceBoundaryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const scanner = ts.createScanner(
    ts.ScriptTarget.ES5,
    true,
    ts.LanguageVariant.Standard,
    left.text + right.text,
  );
  const firstKind = scanner.scan();
  const firstText = scanner.getTokenText();
  const secondKind = scanner.scan();
  const secondText = scanner.getTokenText();
  const removable =
    firstKind === left.kind &&
    firstText === left.text &&
    secondKind === right.kind &&
    secondText === right.text &&
    scanner.scan() === ts.SyntaxKind.EndOfFileToken;
  whitespaceBoundaryCache.set(cacheKey, removable);
  return removable;
}

export function removeKhanWhitespace(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES5,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: PrintedToken[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push({ kind, text: scanner.getTokenText() });
  }

  const output: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === ts.SyntaxKind.NewLineTrivia) {
      if (output.at(-1) !== "\n") output.push("\n");
      continue;
    }
    if (token.kind !== ts.SyntaxKind.WhitespaceTrivia) {
      output.push(token.text);
      continue;
    }

    let leftIndex = index - 1;
    while (leftIndex >= 0 && tokens[leftIndex]!.kind === ts.SyntaxKind.WhitespaceTrivia) leftIndex--;
    let rightIndex = index + 1;
    while (
      rightIndex < tokens.length &&
      tokens[rightIndex]!.kind === ts.SyntaxKind.WhitespaceTrivia
    ) rightIndex++;
    const left = tokens[leftIndex];
    const right = tokens[rightIndex];
    const touchesLineBreak =
      left?.kind === ts.SyntaxKind.NewLineTrivia || right?.kind === ts.SyntaxKind.NewLineTrivia;
    if (left && right && !touchesLineBreak && !canRemoveWhitespace(left, right)) {
      output.push(" ");
    }
  }
  return output.join("").trim();
}

export function condenseKhanLines(source: string): string {
  // This runs only after Terser's beautified printer has emitted explicit
  // trailing semicolons and removeKhanWhitespace has retained every required
  // token separator. At that point line breaks carry no syntax and Khan accepts
  // the fully condensed form, unlike Terser's own semicolon-eliding one-liner.
  const maximumLineLength = 4_096;
  const output: string[] = [];
  let current = "";
  for (const rawLine of source.trim().split(/\r?\n/)) {
    const line = rawLine.trim();
    if (current && current.length + line.length > maximumLineLength) {
      output.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) output.push(current);
  return output.join("\n");
}

function transpileAuthorSource(source: string, entryPath: string): string {
  if (/^\s*(?:import|export)\b/m.test(source)) {
    throw new Error(
      "Unresolved module syntax remains after bundling",
    );
  }
  const result = ts.transpileModule(source, {
    fileName: entryPath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const formatted = ts.formatDiagnostics(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    });
    throw new Error(`Could not transpile ${entryPath}:\n${formatted}`);
  }
  return result.outputText.trim();
}

export async function minifyKhanProgram(source: string): Promise<string> {
  const result = await minify(source, {
    ecma: 5,
    // Khan's ProcessingJS parser still applies IE8-era catch-scope rules.
    // This prevents a mangled catch parameter from shadowing an outer name.
    ie8: true,
    module: false,
    compress: {
      ecma: 5,
      passes: 3,
      toplevel: true,
      top_retain: [...PROCESSING_CALLBACKS],
      arrows: false,
      // Khan's scope checker treats `var` declarations as block-scoped even
      // though ProcessingJS executes ES5. Hoisting declarations prevents a
      // mangled binding first declared in one branch from appearing undefined
      // when reused in a sibling branch.
      hoist_vars: true,
      // Khan's BabyHint parser rejects comma-expression statements and
      // brace-less conditionals even though both are valid ES5. Disabling
      // these two print forms keeps generated statements unambiguous to it.
      sequences: false,
      conditionals: false,
      // Khan does not recognize `!function(){}()` as a call statement.
      negate_iife: false,
      // Terser may shorten a strict comparison to `==` when inferred operand
      // types make it equivalent. Khan's lint rules require `===`/`!==`.
      comparisons: false,
      // Avoid folding `value = create(); return value;` into
      // `return value = create();`, which Khan rejects as an assignment in a
      // return expression.
      collapse_vars: false,
      // Terser documents the string mode `keep_assign`, but its bundled .d.ts
      // currently narrows this field to boolean. This keeps assignments in
      // nested scopes from becoming bare property expressions that Khan's
      // parser rejects, while ordinary unused bindings are still removed.
      unused: "keep_assign" as unknown as boolean,
      unsafe: false,
    },
    mangle: {
      toplevel: true,
      reserved: KHAN_MANGLE_RESERVED,
    },
    format: {
      ascii_only: true,
      // Compact Terser output omits statement-final semicolons that Khan's
      // legacy linter requires. First print an unindented, semicolon-safe
      // layout; removeKhanWhitespace strips optional intra-line spaces while
      // retaining these statement boundaries below.
      beautify: true,
      braces: true,
      comments: false,
      ecma: 5,
      indent_level: 0,
      // Khan requires a leading zero on fractional literals (`0.5`, not
      // `.5`). Terser normally chooses the shorter spelling.
      keep_numbers: true,
      semicolons: true,
    },
  });
  if (!result.code) throw new Error("Terser produced an empty Khan program");
  return `${condenseKhanLines(removeKhanWhitespace(result.code))}\n`;
}

export async function analyzeProject(manifestPath = "kapplus.json"): Promise<ProjectAnalysis> {
  const loaded = await loadManifest(manifestPath);
  const entryPath = path.resolve(loaded.rootDir, loaded.manifest.entry);
  const bundled = await bundleProject(entryPath, loaded.manifest);
  transpileAuthorSource(bundled.sourceWithoutImports, entryPath);
  return { ...loaded, ...bundled };
}

export async function compileProject(manifestPath = "kapplus.json"): Promise<BuildResult> {
  const analysis = await analyzeProject(manifestPath);
  return compileAnalysis(analysis);
}

async function compileAnalysis(analysis: ProjectAnalysis): Promise<BuildResult> {
  const entryPath = path.resolve(analysis.rootDir, analysis.manifest.entry);
  const transpiled = transpileAuthorSource(analysis.sourceWithoutImports, entryPath);
  const localProgram = emitProgram("local", analysis.manifest, transpiled, analysis.assets);
  const khanProgram = await minifyKhanProgram(
    emitProgram("khan", analysis.manifest, transpiled, analysis.assets),
  );
  if (Buffer.byteLength(khanProgram) > analysis.manifest.assets.maxBundleBytes) {
    const audioDetails = analysis.assets
      .filter((asset): asset is Extract<typeof asset, { kind: "audio" }> => asset.kind === "audio")
      .map((asset) => `${path.basename(asset.sourcePath)}: ${asset.bytes.length.toLocaleString()} bytes`)
      .join(", ");
    throw new Error(
      `Khan bundle is ${Buffer.byteLength(khanProgram).toLocaleString()} bytes; ` +
        `the configured limit is ${analysis.manifest.assets.maxBundleBytes.toLocaleString()} bytes` +
        (audioDetails ? `. Embedded audio after optimization: ${audioDetails}` : ""),
    );
  }
  return {
    localProgram,
    localHtml: emitLocalHtml(analysis.manifest, localProgram),
    khanProgram,
    assets: analysis.assets,
  };
}

export async function writeProject(manifestPath = "kapplus.json"): Promise<{
  analysis: ProjectAnalysis;
  result: BuildResult;
  outDir: string;
}> {
  const analysis = await analyzeProject(manifestPath);
  const result = await compileAnalysis(analysis);
  const outDir = path.resolve(analysis.rootDir, analysis.manifest.outDir);
  await Promise.all([
    fs.mkdir(path.join(outDir, "local"), { recursive: true }),
    fs.mkdir(path.join(outDir, "khan"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(outDir, "local", "program.pjs"), result.localProgram),
    fs.writeFile(path.join(outDir, "local", "index.html"), result.localHtml),
    fs.writeFile(path.join(outDir, "khan", "program.js"), result.khanProgram),
  ]);
  return { analysis, result, outDir };
}
