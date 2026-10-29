import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject, compileProject } from "../src/compiler.js";
import { textureFixture } from "./png-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-modules-"));
  roots.push(root);
  files["kapplus.json"] = JSON.stringify({ entry: "main.js" });
  await Promise.all(Object.entries(files).map(async ([file, content]) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }));
  return path.join(root, "kapplus.json");
}

describe("JavaScript project modules", () => {
  it("retains script callback declarations in a CommonJS consumer", async () => {
    const manifest = await project({
      "package.json": '{"type":"commonjs"}',
      "main.js": "function setup(){frameRate(60);} var draw=function(){background(42);};",
    });
    const analysis = await analyzeProject(manifest);
    const calls: number[] = [];
    const sandbox = vm.createContext({ frameRate: (value: number) => calls.push(value), background: (value: number) => calls.push(value) });
    vm.runInContext(analysis.sourceWithoutImports, sandbox);
    sandbox.setup(); sandbox.draw();
    expect(calls).toEqual([60, 42]);
    expect((await compileProject(manifest)).khanProgram).toContain("draw=");
  });

  it("bundles nested imports, re-exports, shared state, JSON, and side effects once", async () => {
    const manifest = await project({
      "main.js": `import "./game/start.js";
        import { move, state } from "./game/index.js";
        import speed from "./settings.json";
        export function draw() { move(speed.step); background(state.x); }`,
      "game/start.js": "effects.push('start');",
      "game/index.js": 'export { state, move } from "./movement.js";',
      "game/movement.js": 'import "./start.js"; export const state = { x: 0 }; export function move(step) { state.x += step; }',
      "settings.json": '{"step":3}',
    });
    const analysis = await analyzeProject(manifest);
    const calls: number[] = [];
    const effects: string[] = [];
    const sandbox = vm.createContext({ background: (value: number) => calls.push(value), effects });
    vm.runInContext(analysis.sourceWithoutImports, sandbox);
    sandbox.draw();
    sandbox.draw();
    expect(calls).toEqual([3, 6]);
    expect(effects).toEqual(["start"]);
    const root = await fs.realpath(path.dirname(manifest));
    expect(analysis.inputFiles.map(file => path.relative(root, file).split(path.sep).join("/")).sort())
      .toEqual(["game/index.js", "game/movement.js", "game/start.js", "main.js", "settings.json"]);
  });

  it("supports default module imports and exported callback aliases", async () => {
    const manifest = await project({
      "main.js": 'import paint from "./paint.js"; export { paint as draw };',
      "paint.js": "export default function paint() { background(42); }",
    });
    const analysis = await analyzeProject(manifest);
    const values: number[] = [];
    const sandbox = vm.createContext({ background: (value: number) => values.push(value) });
    vm.runInContext(analysis.sourceWithoutImports, sandbox);
    sandbox.draw();
    expect(values).toEqual([42]);
    expect((await compileProject(manifest)).khanProgram).not.toMatch(/\b(?:import|export)\s/);
  });

  it("resolves browser-compatible npm modules from the consumer project", async () => {
    const manifest = await project({
      "main.js": 'import { multiply } from "math-fixture"; draw = function() { background(multiply(4, 5)); };',
      "node_modules/math-fixture/package.json": '{"name":"math-fixture","type":"module","exports":"./index.js"}',
      "node_modules/math-fixture/index.js": "export function multiply(a, b) { return a * b; }",
    });
    const analysis = await analyzeProject(manifest);
    const values: number[] = [];
    const sandbox = vm.createContext({ background: (value: number) => values.push(value) });
    vm.runInContext(analysis.sourceWithoutImports, sandbox);
    sandbox.draw();
    expect(values).toEqual([20]);
  });

  it("loads assets relative to the importing module and deduplicates shared files", async () => {
    const manifest = await project({
      "main.js": 'import { sprite } from "./game/sprite.js"; import again from "./images/player.png"; draw=function(){image(sprite.image(),0,0); image(again.image(),1,1);};',
      "game/sprite.js": 'export { default as sprite } from "../images/player.png";',
      "images/player.png": textureFixture(8),
    });
    const analysis = await analyzeProject(manifest);
    expect(analysis.assets).toHaveLength(1);
    expect(analysis.assets[0]).toMatchObject({ kind: "texture", width: 8, height: 8 });
    expect(analysis.inputFiles).toContain(await fs.realpath(path.join(path.dirname(manifest), "images/player.png")));
    await expect(compileProject(manifest)).resolves.toHaveProperty("khanProgram");
    const first = await compileProject(manifest);
    const second = await compileProject(manifest);
    expect(second.khanProgram).toBe(first.khanProgram);
  });

  it("reports missing modules and unavailable Node APIs with source locations", async () => {
    const missing = await project({ "main.js": 'import value from "./missing.js"; draw=function(){background(value);};' });
    await expect(analyzeProject(missing)).rejects.toThrow(/main\.js.*|Could not resolve/s);
    const node = await project({ "main.js": 'import fs from "node:fs"; draw=function(){background(fs.readFileSync("x"));};' });
    await expect(analyzeProject(node)).rejects.toThrow(/node:fs/);
  });

  it("applies manifest canvas dimensions and then honors an author's explicit size", async () => {
    const manifest = await project({
      "main.js": "export function setup() { size(128, 96); } export function draw() {}",
    });
    await fs.writeFile(manifest, JSON.stringify({ entry: "main.js", canvas: { width: 600, height: 540 } }));
    const output = await compileProject(manifest);
    const sizes: number[][] = [];
    const sandbox = vm.createContext({
      getSound: () => ({ audio: { ownerDocument: { defaultView: { atob, Reflect } } } }),
      floor: Math.floor, round: Math.round, ARGB: 0,
      size: (...values: number[]) => sizes.push(values),
    });
    vm.runInContext(output.khanProgram, sandbox);
    sandbox.setup();
    expect(sizes).toEqual([[600, 540], [128, 96]]);
  });
});
