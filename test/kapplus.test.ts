import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { textureFixture } from "./png-fixture.js";
import {
  analyzeProject,
  compileProject,
  condenseKhanLines,
  minifyKhanProgram,
  removeKhanWhitespace,
  writeProject,
} from "../src/compiler.js";
import { bootstrapSource, buildChunkBundle } from "../src/chunks.js";
import { loadAssets } from "../src/assets.js";
import { runtimeFor } from "../src/runtime.js";
import { emitAsset } from "../src/emitter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-test-"));
  temporaryDirectories.push(root);
  await Promise.all([
    fs.writeFile(
      path.join(root, "kapplus.json"),
      JSON.stringify({ name: "fixture", entry: "main.js", outDir: "build" }),
    ),
    fs.writeFile(
      path.join(root, "main.js"),
      [
        'import model from "./model.obj";',
        'import texture from "./texture.png";',
        'import sound from "./sound.mp3";',
        "const counts = () => `${model.triangleCount}:${texture.width}`;",
        "mouseClicked = function() { sound.play(); };",
        "draw = function() { background(0); text(counts(), 10, 20); };",
      ].join("\n"),
    ),
    fs.writeFile(
      path.join(root, "model.obj"),
      ["v 0 0 0", "v 1 0 0", "v 0 1 0", "vt 0 0", "vt 1 0", "vt 0 1", "f 1/1 2/2 3/3"].join("\n"),
    ),
    fs.writeFile(path.join(root, "texture.png"), textureFixture()),
    fs.writeFile(path.join(root, "sound.mp3"), Buffer.from("ID3-kapplus-fixture")),
  ]);
  return path.join(root, "kapplus.json");
}

describe("KAP+ compiler", () => {
  it("removes optional whitespace without changing strings or token boundaries", () => {
    const source = [
      "var value = first + second;",
      "var incremented = first + ++second;",
      "var matched = first / /x/.test(label);",
      'draw = function() { text("keep these spaces", value, 20); };',
    ].join("\n");
    const compact = removeKhanWhitespace(source);

    expect(compact).toBe([
      "var value=first+second;",
      "var incremented=first+ ++second;",
      "var matched=first/ /x/.test(label);",
      'draw= function(){text("keep these spaces",value,20);};',
    ].join("\n"));
  });

  it("condenses semicolon-safe logic into one line", () => {
    const source = [
      "if (ready) {",
      "first();",
      "} else {",
      "second();",
      "}",
    ].join("\n");

    expect(condenseKhanLines(source)).toBe("if (ready) {first();} else {second();}");
  });

  it("wraps very large condensed programs before Khan's parser line limit", () => {
    const source = Array.from({ length: 80 }, (_, index) =>
      `value${index}=${JSON.stringify("x".repeat(80))};`
    ).join("\n");
    const condensed = condenseKhanLines(source);

    expect(condensed).toContain("\n");
    expect(condensed.split("\n").every((line) => line.length <= 4_096)).toBe(true);
    expect(condensed.replace(/\n/g, "")).toBe(source.replace(/\n/g, ""));
  });

  it("loads OBJ, PNG, and MP3 imports into a target-neutral project", async () => {
    const project = await analyzeProject(await createFixture());

    expect(project.assets.map((asset) => asset.kind).sort()).toEqual(["audio", "mesh", "texture"]);
    expect(project.sourceWithoutImports).not.toContain("import ");
    const mesh = project.assets[0];
    expect(mesh?.kind).toBe("mesh");
    if (mesh?.kind === "mesh") expect(mesh.indices).toHaveLength(3);
  });

  it("preserves source-quality MP3 bytes without transcoding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-source-audio-"));
    temporaryDirectories.push(root);
    const entryPath = path.join(root, "main.js");
    const audioPath = path.join(root, "source.mp3");
    const original = Buffer.alloc(1_100_000, 93);
    const source = 'import audio from "./source.mp3";\ndraw=function(){background(0);};';
    await Promise.all([
      fs.writeFile(entryPath, source),
      fs.writeFile(audioPath, original),
    ]);

    const loaded = await loadAssets(entryPath, source, 128, "source");
    const audio = loaded.assets[0];
    expect(audio?.kind).toBe("audio");
    if (audio?.kind === "audio") expect(audio.bytes.equals(original)).toBe(true);
  });

  it("supports compact, high-quality, and source texture profiles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-texture-quality-"));
    temporaryDirectories.push(root);
    const entryPath = path.join(root, "main.js");
    const source = 'import texture from "./texture.png";';
    await Promise.all([
      fs.writeFile(entryPath, source),
      fs.writeFile(path.join(root, "texture.png"), textureFixture()),
    ]);

    const compact = (await loadAssets(entryPath, source, 64, "compact", "compact")).assets[0];
    const high = (await loadAssets(entryPath, source, 128, "compact", "high")).assets[0];
    const original = (await loadAssets(entryPath, source, 64, "compact", "source")).assets[0];
    expect(compact).toMatchObject({
      kind: "texture", width: 64, height: 64, pixelFormat: "rgb5551", filter: "nearest",
    });
    expect(high).toMatchObject({
      kind: "texture", width: 128, height: 128, pixelFormat: "rgba8888", filter: "linear",
    });
    expect(original).toMatchObject({
      kind: "texture", width: 512, height: 512, pixelFormat: "rgba8888", filter: "linear",
    });
  });

  it("decodes RGBA textures and samples them bilinearly in the generated runtime", () => {
    const writes: Array<[number, number, number[]]> = [];
    const sandbox: Record<string, unknown> = {
      ARGB: 2,
      atob,
      floor: Math.floor,
      round: Math.round,
      color: (...channels: number[]) => channels,
      createImage: () => ({
        set: (x: number, y: number, value: number[]) => writes.push([x, y, value]),
      }),
      URL,
      Blob,
      Audio: function() {},
      Uint8Array,
    };
    const assetSource = emitAsset({
      kind: "texture",
      name: "texture",
      sourcePath: "texture.png",
      width: 2,
      height: 2,
      pixelFormat: "rgba8888",
      filter: "linear",
      pixels: [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff],
    });
    vm.runInNewContext(`${runtimeFor("local", false)}\n${assetSource}`, sandbox);
    const texture = sandbox.texture as {
      sampleNearest: (u: number, v: number) => number[];
      sampleLinear: (u: number, v: number) => number[];
      image: () => unknown;
    };

    expect(Array.from(texture.sampleNearest(0.25, 0.25))).toEqual([255, 0, 0, 255]);
    expect(Array.from(texture.sampleLinear(0.5, 0.5))).toEqual([128, 128, 128, 255]);
    texture.image();
    expect(writes).toEqual([
      [0, 0, [255, 0, 0, 255]],
      [1, 0, [0, 255, 0, 255]],
      [0, 1, [0, 0, 255, 255]],
      [1, 1, [255, 255, 255, 255]],
    ]);
  });

  it("exposes a one-shot WebGL thumbnail capture method", () => {
    const runtime = runtimeFor("local", false);
    expect(runtime).toContain("var thumbnail = function(thumbnailOptions)");
    expect(runtime).toContain("thumbnail: thumbnail");
    expect(runtime).toContain('thumbnailOptions.type || "image/png"');
  });

  it("mirrors WebGL frames to the Processing canvas while Space is held", () => {
    const runtime = runtimeFor("khan", false);
    expect(runtime).toContain('nativeWindow.addEventListener("keydown", handleThumbnailKeyDown, true)');
    expect(runtime).toContain('nativeWindow.addEventListener("keyup", handleThumbnailKeyUp, true)');
    expect(runtime).toContain("thumbnailContext.drawImage(");
    expect(runtime).toContain("showThumbnail: showThumbnailCanvas");
    expect(runtime).toContain("hideThumbnail: hideThumbnailCanvas");
  });

  it("emits local and Khan programs with ES5 author code", async () => {
    const result = await compileProject(await createFixture());

    expect(result.khanProgram.length).toBeLessThan(result.localProgram.length);
    expect(result.khanProgram).not.toMatch(/\bconst\b|=>|^\s*import\s/m);
    expect(result.khanProgram).not.toContain("new Audio(");
    expect(result.khanProgram).not.toContain("data:audio/mpeg;base64");
    expect(result.khanProgram).not.toContain("// Generated by KAP+");
    expect(result.localProgram).toContain("// Generated by KAP+");
    expect(result.localProgram).toContain("decodeBase85Into(data, bytes, byteLength)");
    expect(result.localProgram).toContain("new Audio(objectUrl)");
    expect(result.localHtml).toContain("KAP+ Preview");
  });

  it("minifies Khan JavaScript while preserving Processing handlers", async () => {
    const source = [
      "// build-only comment",
      "var unusedProductionValue = 12345;",
      "var deliberatelyLongHelperName = function(deliberatelyLongArgumentName) {",
      "  if (true) { return deliberatelyLongArgumentName + 1; }",
      "  return unusedProductionValue;",
      "};",
      "var setup = function() { size(400, 400); };",
      "draw = function() { background(deliberatelyLongHelperName(0)); };",
    ].join("\n");
    const minified = await minifyKhanProgram(source);

    expect(minified.length).toBeLessThan(source.length);
    expect(minified).not.toContain("build-only comment");
    expect(minified).not.toContain("deliberatelyLongHelperName");
    expect(minified).not.toContain("deliberatelyLongArgumentName");
    expect(minified).not.toContain("unusedProductionValue");
    expect(minified).toMatch(/\bsetup\b/);
    expect(minified).toMatch(/\bdraw\b/);
    expect(minified).not.toContain("if(");

    const calls: Array<[string, number[]]> = [];
    const sandbox: Record<string, unknown> = {
      size: (...values: number[]) => calls.push(["size", values]),
      background: (...values: number[]) => calls.push(["background", values]),
    };
    vm.runInNewContext(minified, sandbox);
    (sandbox.setup as () => void)();
    (sandbox.draw as () => void)();
    expect(calls).toEqual([
      ["size", [400, 400]],
      ["background", [1]],
    ]);
  });

  it("keeps compressed output compatible with Khan's legacy syntax checks", async () => {
    const source = [
      "var cachedValue;",
      "var readValue = function(flag) {",
      "  if (flag) {",
      "    var branchValue = 0.5;",
      "    consume(branchValue);",
      "  } else {",
      "    var branchValue = 0.25;",
      "    consume(branchValue);",
      "  }",
      "  if (cachedValue === undefined) {",
      "    cachedValue = branchValue;",
      "  }",
      "  return cachedValue;",
      "};",
      "draw = function() { background(readValue(nextFlag())); };",
    ].join("\n");
    const minified = await minifyKhanProgram(source);

    expect(minified).not.toMatch(/(^|[^\w$])\.\d/m);
    expect(minified).not.toMatch(/(^|[^=!])==([^=]|$)/m);
    expect(minified).not.toMatch(/!\s*function\s*\(/);
    expect(minified).not.toMatch(/return\s+[A-Za-z_$][\w$]*\s*=(?!=)/);
    expect(minified).not.toMatch(/(?:if|else)[^{]*\{\s*var\b/);

    const consumed: number[] = [];
    const backgrounds: number[] = [];
    const sandbox: Record<string, unknown> = {
      consume: (value: number) => consumed.push(value),
      nextFlag: () => false,
      background: (value: number) => backgrounds.push(value),
    };
    vm.runInNewContext(minified, sandbox);
    (sandbox.draw as () => void)();
    expect(consumed).toEqual([0.25]);
    expect(backgrounds).toEqual([0.25]);
  });

  it("stops every active Khan audio context when the program restarts", () => {
    const contexts: FakeAudioContext[] = [];
    const pendingDecodes: Array<(decoded: { duration: number }) => void> = [];
    class FakeSource {
      stopped = false;
      buffer: { duration: number } | null = null;
      onended: (() => void) | null = null;
      connect() {}
      start() {}
      stop() { this.stopped = true; }
    }
    class FakeAudioContext {
      state = "running";
      destination = {};
      sources: FakeSource[] = [];
      constructor() { contexts.push(this); }
      createBufferSource() {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
      }
      decodeAudioData(_bytes: ArrayBuffer, success: (decoded: { duration: number }) => void) {
        if (contexts.indexOf(this) === 0) success({ duration: 10 });
        else pendingDecodes.push(success);
      }
      close() { this.state = "closed"; }
    }
    const audioWindow: Record<string, unknown> = {
      AudioContext: FakeAudioContext,
      Reflect,
      Uint8Array,
      Uint8ClampedArray,
      ImageData: class {},
      atob: () => "",
    };
    const sandbox: Record<string, unknown> = {
      floor: Math.floor,
      round: Math.round,
      createImage: () => ({}),
      ARGB: 0,
      getSound: () => ({ audio: { ownerDocument: { defaultView: audioWindow } } }),
    };
    vm.createContext(sandbox);
    vm.runInContext(runtimeFor("khan", true), sandbox);
    vm.runInContext("first = KAPPlus.audio('00000', 1); second = KAPPlus.audio('00000', 1); first.play(); second.play();", sandbox);

    expect(contexts).toHaveLength(2);
    expect(contexts.every((context) => context.state === "running")).toBe(true);
    expect(contexts[0]?.sources).toHaveLength(1);
    expect(contexts[1]?.sources).toHaveLength(0);

    // Restarting into a project with no audio assets must still clean up audio
    // retained by the previous generated program.
    vm.runInContext(runtimeFor("khan", false), sandbox);

    expect(contexts.every((context) => context.state === "closed")).toBe(true);
    expect(contexts[0]?.sources[0]?.stopped).toBe(true);

    // A decode callback can arrive after close(); it must not create or start
    // a new source from the discarded program instance.
    pendingDecodes[0]?.({ duration: 10 });
    expect(contexts[1]?.sources).toHaveLength(0);
  });

  it("writes both target layouts", async () => {
    const projectPath = await createFixture();
    const result = await writeProject(projectPath);

    await expect(fs.stat(path.join(result.outDir, "local", "index.html"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.outDir, "local", "program.pjs"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.outDir, "khan", "program.js"))).resolves.toBeTruthy();
  });

  it("creates exact content-addressed chunks and a compact branch bootstrap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-chunks-"));
    temporaryDirectories.push(root);
    const source = "var message='chunked';draw=function(){background(20);text(message,10,20);};\n";
    const result = await buildChunkBundle({
      source,
      outputDirectory: root,
      baseUrl: "https://cdn.jsdelivr.net/gh/example/assets@main",
      projectName: "chunk fixture",
      chunkCount: 4,
    });

    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    for (const chunk of result.manifest.chunks) {
      vm.runInContext(await fs.readFile(path.join(root, chunk.file), "utf8"), sandbox);
    }
    const registry = sandbox.__kapplusPublishChunks as Record<string, string[]>;
    expect(registry[result.manifest.buildId]?.join("")).toBe(source);
    expect(result.bootstrap).toContain("cdn.jsdelivr.net/gh/example/assets@main");
    expect(Buffer.byteLength(result.bootstrap)).toBeLessThan(Buffer.byteLength(source) + 6_000);
    expect(result.manifest.sourceBytes).toBe(Buffer.byteLength(source));
    expect(result.manifest.chunkCount).toBe(4);
  });

  it("pins chunk URLs to separate release tags without changing their contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-sharded-chunks-"));
    temporaryDirectories.push(root);
    const source = "draw=function(){background(42);};".repeat(20);
    const result = await buildChunkBundle({
      source,
      outputDirectory: root,
      baseUrl: "https://cdn.jsdelivr.net/gh/example/assets@0.0.12",
      projectName: "sharded fixture",
      chunkCount: 4,
      chunkRevision: (index) => index < 2 ? "0.0.11" : "0.0.12",
    });
    expect(result.manifest.chunks.map((chunk) => chunk.revision)).toEqual([
      "0.0.11", "0.0.11", "0.0.12", "0.0.12",
    ]);
    const bootstrap = await fs.readFile(path.join(root, "bootstrap.js"), "utf8").catch(() => result.bootstrap);
    expect(bootstrap).toContain("assets@0.0.11");
    expect(bootstrap).toContain("assets@0.0.12");
    const sandbox: Record<string, unknown> = {};
    vm.createContext(sandbox);
    for (const chunk of result.manifest.chunks) {
      vm.runInContext(await fs.readFile(path.join(root, chunk.file), "utf8"), sandbox);
    }
    const registry = sandbox.__kapplusPublishChunks as Record<string, string[]>;
    expect(registry[result.manifest.buildId]?.join("")).toBe(source);
  });

  it("automatically sizes chunk counts from a target byte budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-auto-chunks-"));
    temporaryDirectories.push(root);
    const source = "setup=function(){background(0);};".repeat(20);
    const result = await buildChunkBundle({
      source,
      outputDirectory: root,
      baseUrl: "https://cdn.jsdelivr.net/gh/example/assets@main",
      projectName: "auto chunks",
      targetChunkBytes: 200,
    });

    expect(result.manifest.chunkCount).toBe(Math.ceil(Buffer.byteLength(source) / 200));
    expect(result.manifest.chunks).toHaveLength(result.manifest.chunkCount);
  });

  it("creates a stable first stage that follows the latest tagged bootstrap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-live-bootstrap-"));
    const updatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-live-bootstrap-update-"));
    temporaryDirectories.push(root, updatedRoot);
    const firstReleaseBase = "https://cdn.jsdelivr.net/gh/example/assets@0.0.1";
    const updatedReleaseBase = "https://cdn.jsdelivr.net/gh/example/assets@0.0.2";
    const liveBootstrapUrl = "https://cdn.jsdelivr.net/gh/example/assets@latest/bootstrap.js";
    const result = await buildChunkBundle({
      source: "setup=function(){size(640,360);};draw=function(){background(12);};",
      outputDirectory: root,
      baseUrl: firstReleaseBase,
      liveBootstrapUrl,
      projectName: "live fixture",
      chunkCount: 3,
    });

    expect(result.bootstrap).toContain(liveBootstrapUrl);
    expect(result.bootstrap).toContain("kapplus=");
    expect(result.bootstrap).toContain('.replace("@latest","@0.0")');
    expect(result.bootstrap).toContain('.replace("@latest","@0.0.x")');
    expect(result.bootstrap).toContain('.replace("@latest","@*")');
    expect(result.bootstrap).not.toContain(`/chunks/${result.manifest.buildId}/chunk-0.js`);
    expect(result.manifest.liveBootstrap).toMatchObject({ file: "bootstrap.js" });

    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(await fs.readFile(path.join(root, "bootstrap.js"), "utf8"), sandbox);
    const current = sandbox.__kapplusCurrentBootstrap as {
      buildId: string;
      releasePatch: number;
      source: string;
    };
    expect(current.buildId).toBe(result.manifest.buildId);
    expect(current.releasePatch).toBe(1);
    expect(current.source).toContain(firstReleaseBase);
    expect(current.source).toContain(`/chunks/${result.manifest.buildId}/chunk-0.js`);
    expect(current.source).toContain(`/chunks/${result.manifest.buildId}/chunk-2.js`);

    const updated = await buildChunkBundle({
      source: "setup=function(){size(800,500);};draw=function(){background(24);ellipse(10,10,5,5);};",
      outputDirectory: updatedRoot,
      baseUrl: updatedReleaseBase,
      liveBootstrapUrl,
      projectName: "updated live fixture",
      chunkCount: 5,
    });
    expect(updated.bootstrap).toBe(result.bootstrap);
    expect(updated.manifest.buildId).not.toBe(result.manifest.buildId);
    const updatedSandbox: Record<string, unknown> = {};
    vm.runInNewContext(
      await fs.readFile(path.join(updatedRoot, "bootstrap.js"), "utf8"),
      updatedSandbox,
    );
    expect((updatedSandbox.__kapplusCurrentBootstrap as { releasePatch: number }).releasePatch).toBe(2);
    const updatedCurrent = updatedSandbox.__kapplusCurrentBootstrap as {
      buildId: string;
      source: string;
    };
    expect(updatedCurrent.buildId).toBe(updated.manifest.buildId);
    expect(updatedCurrent.source).toContain(updatedReleaseBase);
    expect(updatedCurrent.source).toContain(`/chunks/${updated.manifest.buildId}/chunk-4.js`);
  });

  it("reports loading progress and preserves setup-only rendering when ready", () => {
    const scripts: Array<{ onload(): void }> = [];
    const backgrounds: number[][] = [];
    const labels: string[] = [];
    const background = (...values: number[]) => backgrounds.push(values);
    const nativeWindow: Record<string, unknown> = {
      Processing: { getInstanceById: () => ({ background }) }, Object, Reflect, Function,
      __kapplusPublishChunks: { "setup-only": ["setup=function(){background(7);};"] },
    };
    const document = {
      defaultView: nativeWindow, createElement: () => ({}),
      head: { appendChild(script: typeof scripts[number]) { scripts.push(script); } },
    };
    const noop = () => {};
    const sandbox = vm.createContext({
      getSound: () => ({ audio: { ownerDocument: document } }), background,
      fill: noop, textAlign: noop, textSize: noop, noStroke: noop, rect: noop,
      text: (label: string) => labels.push(label), min: Math.min, width: 400, height: 400, CENTER: 0,
    });
    vm.runInContext(bootstrapSource("setup-only", ["https://example.test/chunk.js"]), sandbox);
    sandbox.draw();
    expect(labels).toContain("loading chunk.js (1/1)");
    scripts[0]!.onload();
    expect(backgrounds.at(-1)).toEqual([7]);
    const painted = backgrounds.length;
    sandbox.draw();
    expect(backgrounds).toHaveLength(painted);
    nativeWindow.__kapplusAssetStatus = { phase: "decoding", current: 1, total: 2, name: "sprite.png" };
    sandbox.draw();
    expect(labels).toContain("Decompiling asset 1 of 2");
    expect(labels).toContain("sprite.png");
  });
});
