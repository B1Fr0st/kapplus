import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProject, startDevServer } from "../dist/index.js";
import { KhanBrowserSession } from "../dist/browser-session.js";
import { buildChunkBundle } from "../dist/chunks.js";
import { loadAsset } from "../dist/assets.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-parity-"));
const project = path.join(root, "game");
const artifacts = path.resolve("artifacts");
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
let dev;
let reference;
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await timeout(150);
  }
  throw new Error(message);
}
async function pixels(bytes, name) {
  const file = path.join(root, name + ".png");
  await fs.writeFile(file, bytes);
  const image = await loadAsset("snapshot", file, 1024, "source", "high");
  assert.equal(image.kind, "texture");
  return image.pixels;
}
async function expectCanvas(level) {
  const expected = ((level * 0x1000000 + level * 0x10000 + level * 0x100 + 255) >>> 0);
  return until(async () => {
    if (dev.getStatus().phase !== "ready") return false;
    const response = await fetch(dev.url + "/api/canvas.png");
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    const values = await pixels(bytes, "dev");
    return values.every(pixel => pixel === expected) ? { bytes, values } : false;
  }, `Actual Khan canvas did not render background ${level}: ${JSON.stringify(dev.getStatus())}`);
}

try {
  await fs.writeFile(path.join(project, "package.json"), '{"private":true,"type":"commonjs"}');
  await initializeProject({ directory: project, name: "Khan preview parity" });
  dev = await startDevServer({ project: path.join(project, "kapplus.json"), port: 0, headless: true,
    onStatus: state => console.log(JSON.stringify(state)) });
  let startupTimer;
  await Promise.race([dev.ready, new Promise((_, reject) => {
    startupTimer = setTimeout(() => reject(new Error("Khan dev preview did not become ready")), 90000);
  })]).finally(() => clearTimeout(startupTimer));
  const status = dev.getStatus();
  assert.equal(status.mode, "khan");
  assert.equal(status.runtime.origin, "https://www.kasandbox.org");
  assert(status.runtime.url.includes("/computer-programming/exec/pjs"));
  assert(status.runtime.version, "The actual deployed Khan runtime must identify its version");
  assert(status.bootstrapBytes < 20000);
  assert(status.sourceBytes > status.bootstrapBytes);
  await until(async () => {
    const response = await fetch(dev.url + "/api/canvas.png");
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    const values = await pixels(bytes, "starter");
    if (values.length !== 400 * 400 || !values.includes(0x121720ff) || !values.includes(0x65c2ffff)) return false;
    await fs.writeFile(path.join(artifacts, "starter-khan.png"), bytes);
    return true;
  }, "The untouched CommonJS starter did not render in Khan");
  console.log("Untouched CommonJS starter rendered in the real Khan sandbox.");

  await fs.writeFile(path.join(project, "game.js"), "export const level = 30;");
  await fs.writeFile(path.join(project, "kapplus.json"), JSON.stringify({ name: "Khan preview parity", entry: "main.js", outDir: "dist", canvas: { width: 160, height: 160 } }));
  await fs.writeFile(path.join(project, "main.js"), `import { level } from "./game.js";
    export function setup() { frameRate(20); }
    export function draw() { background(level); }`);
  await expectCanvas(30);

  const before = dev.getStatus().buildId;
  await fs.writeFile(path.join(project, "game.js"), "export const level = 73;");
  await until(() => dev.getStatus().phase === "ready" && dev.getStatus().buildId !== before, "Imported module edit was not rebuilt");
  await expectCanvas(73);
  await fs.writeFile(path.join(project, "game.js"), "export const level = ;");
  await until(() => dev.getStatus().phase === "error", "Compile error was not reported");
  assert(dev.getStatus().error.includes("game.js"));
  const retained = await pixels(Buffer.from(await (await fetch(dev.url + "/api/canvas.png")).arrayBuffer()), "retained");
  assert(retained.every(pixel => pixel === 0x494949ff), "A broken edit changed the last successful Khan preview");
  await fs.writeFile(path.join(project, "game.js"), "export const level = 111;");
  const final = await expectCanvas(111);
  await fs.writeFile(path.join(artifacts, "dev-khan.png"), final.bytes);

  // Load the exact publication artifact in an independent Khan session and
  // compare every RGBA pixel, not a local imitation of ProcessingJS.
  const source = await fs.readFile(path.join(project, "dist", "khan", "program.js"), "utf8");
  assert.equal(crypto.createHash("sha256").update(source).digest("hex").slice(0, 16), dev.getStatus().buildId);
  const directory = path.join(root, "reference");
  const baseUrl = "https://cdn.jsdelivr.net/kapplus-parity-reference";
  const bundle = await buildChunkBundle({ source, outputDirectory: directory, baseUrl, projectName: "Publication reference" });
  reference = new KhanBrowserSession({ headless: true });
  await reference.open();
  const page = await reference.getPage();
  const files = new Map(bundle.manifest.chunks.map(chunk => ["/" + chunk.file, chunk]));
  await page.route(baseUrl + "/**", async route => {
    const pathname = new URL(route.request().url()).pathname.slice(new URL(baseUrl).pathname.length);
    const chunk = files.get(pathname);
    assert(chunk, "Unexpected reference chunk");
    const bytes = await fs.readFile(path.join(directory, chunk.file));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), chunk.sha256);
    await route.fulfill({ contentType: "application/javascript", body: bytes });
  });
  const editor = await reference.setCode(bundle.bootstrap, 500);
  assert.equal(editor.code, bundle.bootstrap);
  // Both sides must start from a clean sandbox. The editor's hot injector can
  // preserve callback closures even on its first programmatic source update.
  await reference.restart(500);
  await reference.waitForKapPlusLoader(30000, bundle.manifest.buildId);
  const frame = page.frames().find(frame => frame.url().includes("/computer-programming/exec/pjs"));
  assert(frame);
  const matched = await until(async () => {
    const url = await frame.locator("#output-canvas").evaluate(canvas => canvas.toDataURL("image/png"));
    const bytes = Buffer.from(url.split(",")[1], "base64");
    await fs.writeFile(path.join(artifacts, "publication-khan.png"), bytes);
    const values = await pixels(bytes, "reference");
    return values.length === final.values.length && values.every((pixel, index) => pixel === final.values[index]) ? bytes : false;
  }, "Development and publication Khan canvases differ");
  await fs.writeFile(path.join(artifacts, "publication-khan.png"), matched);
  assert.deepEqual((await reference.getState()).errors, []);
  console.log("Khan parity passed: real sandbox/version, verified chunks, module hot rebuild, error recovery, and identical publication pixels.");
} catch (error) {
  const referenceState = await reference?.getState().catch(failure => ({ error: String(failure) }));
  await fs.writeFile(path.join(artifacts, "khan-error.json"), JSON.stringify({ error: String(error), stack: error.stack, status: dev?.getStatus(), reference: referenceState }, null, 2));
  throw error;
} finally {
  await reference?.close();
  await dev?.close();
  await fs.rm(root, { recursive: true, force: true });
}
