import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileProject } from "../dist/index.js";
import { KhanBrowserSession } from "../dist/browser-session.js";
import { buildChunkBundle } from "../dist/chunks.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-websocket-"));
const artifacts = path.resolve("artifacts");
const directory = path.join(root, "chunks");
const baseUrl = "https://cdn.jsdelivr.net/kapplus-websocket-test";
const files = new Map();
const session = new KhanBrowserSession({ headless: true });
const source = tag => `
var view = getSound("rpg/metal-clink").audio.ownerDocument.defaultView;
var probe = { state: "connecting", tag: "${tag}", text: false, binary: false, messages: [] };
view.__kapplusWebSocketTest = probe;
var network = KAPPlus.createNetwork({ timeoutMs: 20000 });
probe.client = network;
network.openWebSocket("wss://echo.websocket.org", { binaryType: "arraybuffer" }).then(function(socket) {
    probe.socket = socket;
    socket.onmessage = function(event) {
        if (typeof event.data === "string") { probe.messages.push(event.data); probe.text = probe.text || event.data === probe.tag; }
        else {
            var bytes = view.Reflect.construct(view.Uint8Array, [event.data]);
            probe.messages.push([bytes.length, bytes[0], bytes[1], bytes[2]]);
            probe.binary = bytes.length === 3 && bytes[0] === 0 && bytes[1] === 128 && bytes[2] === 255;
        }
        if (probe.text && probe.binary) { probe.state = "passed"; }
    };
    socket.onclose = function(event) { probe.closeCode = event.code; };
    socket.send(probe.tag);
    socket.send(view.Reflect.construct(view.Uint8Array, [[0, 128, 255]]));
}).catch(function(error) { probe.state = "error"; probe.error = error.code + ": " + error.message; });
export function draw() { background(probe.state === "passed" ? 73 : 18); }
`;
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(message);
}
let page;
const outputFrame = () => page.frames().find(frame => frame.url().includes("/computer-programming/exec/pjs"));
async function load(tag) {
  await fs.writeFile(path.join(root, "main.js"), source(tag));
  const build = await compileProject(path.join(root, "kapplus.json"));
  assert(!/RTCPeerConnection|createPeer|stun:/.test(build.khanProgram), "Removed transport code is present in the bundle");
  const bundle = await buildChunkBundle({ source: build.khanProgram, outputDirectory: directory, baseUrl, projectName: "WebSocket verification" });
  assert(bundle.manifest.bootstrapBytes < 20000);
  files.clear(); for (const chunk of bundle.manifest.chunks) files.set("/" + chunk.file, chunk);
  const editor = await session.setCode(bundle.bootstrap, 500);
  assert.equal(editor.code, bundle.bootstrap);
  await session.restart(500);
  await session.waitForKapPlusLoader(30000, bundle.manifest.buildId);
  return until(async () => {
    const state = await outputFrame().evaluate(() => {
      const probe = globalThis.__kapplusWebSocketTest;
      return probe && { state: probe.state, tag: probe.tag, text: probe.text, binary: probe.binary, error: probe.error, readyState: probe.socket?.readyState };
    });
    if (state?.state === "error") throw new Error(state.error);
    return state?.tag === tag && state?.state === "passed" ? state : false;
  }, "Native WSS text/binary echo did not complete");
}
try {
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"commonjs"}');
  await fs.writeFile(path.join(root, "kapplus.json"), '{"entry":"main.js"}');
  await session.open(); page = await session.getPage();
  await page.route(baseUrl + "/**", async route => {
    const chunk = files.get(new URL(route.request().url()).pathname.slice(new URL(baseUrl).pathname.length));
    assert(chunk, "Unexpected WebSocket test chunk");
    const bytes = await fs.readFile(path.join(directory, chunk.file));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), chunk.sha256);
    await route.fulfill({ contentType: "application/javascript", body: bytes });
  });
  const first = await load("kapplus-wss-first");
  assert.equal(first.readyState, 1);
  const previousSocket = await outputFrame().evaluateHandle(() => globalThis.__kapplusWebSocketTest.socket);
  const second = await load("kapplus-wss-second");
  await until(() => previousSocket.evaluate(socket => socket.readyState >= 2), "Restart left the old socket open");
  await previousSocket.dispose();
  await outputFrame().evaluate(() => globalThis.__kapplusWebSocketTest.client.close());
  await until(() => outputFrame().evaluate(() => globalThis.__kapplusWebSocketTest.socket.readyState >= 2), "Client close left the socket open");
  assert.equal(await outputFrame().locator("iframe[data-kapplus-network]").count(), 0);
  assert.deepEqual((await session.getState()).errors, []);
  await fs.writeFile(path.join(artifacts, "websocket-khan.json"), JSON.stringify({ first, second, restartCleanup: true, closeCleanup: true }, null, 2));
  console.log("Khan WebSocket check passed: real WSS text/binary echo, restart cleanup, and explicit close.");
} catch (error) {
  const probe = await outputFrame()?.evaluate(() => {
    const value = globalThis.__kapplusWebSocketTest;
    return value && { state: value.state, text: value.text, binary: value.binary, messages: value.messages, error: value.error, readyState: value.socket?.readyState };
  }).catch(() => null);
  console.error("WebSocket diagnostic:", JSON.stringify(probe));
  await fs.writeFile(path.join(artifacts, "websocket-error.json"), JSON.stringify({ error: String(error), stack: error.stack, probe, state: await session.getState().catch(() => null) }, null, 2));
  throw error;
} finally { await session.close(); await fs.rm(root, { recursive: true, force: true }); }
