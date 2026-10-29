export const api = [
  { id: "createNetwork", category: "Sketch runtime", signature: "KAPPlus.createNetwork(options?) → NetworkClient", summary: "Make direct or proxied HTTP requests with timeouts and cancellation.", body: `Returns a client with fetch(url, options) and close(). Construction is synchronous; the first request initializes the context. Omit proxyUrl for direct browser requests, which retain CORS restrictions. A proxy must allow the target origin.

\`\`\`js
const network = KAPPlus.createNetwork({
    proxyUrl: "https://YOUR_PROXY.workers.dev/fetch",
    timeoutMs: 15000
});
network.fetch("https://YOUR_API.example/data").then(function(response) {
    if (!response.ok) { throw new Error("HTTP " + response.status); }
    return response.json();
}).then(function(data) {
    // Update state used by draw().
});
\`\`\`

Requests accept method, headers, body, signal, cache, and timeoutMs. Supported methods are GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS. Serialize JSON explicitly. GET and HEAD reject bodies; targets must be absolute HTTPS URLs without credentials or fragments.

The result is a native Response. Upstream HTTP errors resolve normally; proxy failures reject with code PROXY_ERROR, status, and proxyCode. Other error codes include NETWORK_TIMEOUT, NETWORK_UNAVAILABLE, NETWORK_INVALID_REQUEST, and NETWORK_CLOSED. Cancellation rejects with AbortError.

Timeouts cover initialization through response headers. Abort signals and close() also stop unfinished bodies. Restarts close previous clients. Redirects are manual: the proxy exposes X-KAPPlus-Location. Browser login cookies are not forwarded.` },
  { id: "createWebGLRenderer", category: "Sketch runtime", signature: "KAPPlus.createWebGLRenderer(options) → Renderer", summary: "Render imported meshes with the native WebGL 2 context.", body: `Pass a required mesh and optional textures array. Other options include width, height, pixelRatio, background, perspective, fov, camera, fit, unlit, anisotropy, and thumbnailHotkey.

\`\`\`js
import model from "./model.glb";
import texture from "./texture.png";
const renderer = KAPPlus.createWebGLRenderer({
    mesh: model, textures: [texture], width: 600, height: 400
});
export function draw() {
    renderer.render(millis() * 0.0002, 0.2);
}
\`\`\`

render(yaw, pitch) draws one view. renderInstances(instances) draws an explicit instance list. thumbnail(options) renders once and returns a PNG data URL by default; it accepts yaw, pitch, instances, type, and quality.

Material-indexed roughness, metallic, roughnessMaps, metallicMaps, and normalMaps are supported. The renderer exposes canvas, gl, stats, triangleCount, sourceTextureCount, and pixelRatio. showThumbnail() and hideThumbnail() mirror the WebGL frame into the Processing canvas. dispose() releases thumbnail event listeners. Creating a replacement renderer removes the previous overlay.` },
  { id: "createPeer", category: "Sketch runtime", signature: "KAPPlus.createPeer(options?) → Peer", summary: "Exchange messages over a WebRTC data channel.", body: `Options include channel, iceServers, ordered, maxRetransmits, maxPacketLifeTime, iceTimeout, onState, onOpen, and onMessage.

\`\`\`js
const peer = KAPPlus.createPeer({
    channel: "my-game",
    onMessage: function(message) { /* update game state */ }
});
peer.createOffer(function(error, code) {
    if (!error) { KAPPlus.promptCode("Copy offer", code, function() {}); }
});
\`\`\`

createOffer(callback) produces a complete offer code. A guest uses acceptOffer(code, callback) to produce an answer; the host calls acceptAnswer(code, callback). send(value) sends a string or JSON-serialized object and reports whether the channel was open. close() closes the connection.

State is exposed as state, role, error, localCodeLength, and remoteCodeLength. The native RTCPeerConnection is available as connection. Default discovery uses public STUN servers; a TURN relay is not configured automatically. Khan restarts close previous peers.` },
  { id: "whenReady", category: "Sketch runtime", signature: "KAPPlus.whenReady(callback) → void", summary: "Wait for imported source textures to finish decoding.", body: `The callback runs immediately when no source textures are pending, or after they finish. This does not wait for HTTP requests or audio playback.

\`\`\`js
KAPPlus.whenReady(function() {
    // Imported source textures can now be sampled.
});
\`\`\`

The compiler automatically defers an author's setup callback when source-quality textures need decoding.` },
  { id: "imageFromPixels", category: "Sketch runtime", signature: "KAPPlus.imageFromPixels(width, height, packedValues) → PImage", summary: "Create a Processing image from packed RGBA8888 pixels.", body: `Values are packed as red, green, blue, alpha in descending bytes. The array contains width × height pixels.

\`\`\`js
const redPixel = KAPPlus.imageFromPixels(1, 1, [0xff0000ff]);
export function draw() { image(redPixel, 20, 20, 100, 100); }
\`\`\`` },
  { id: "promptCode", category: "Sketch runtime", signature: "KAPPlus.promptCode(label, value, callback) → CodePanel", summary: "Show a text entry and copy panel inside the output frame.", body: `Pass a label, an initial string, and a completion callback. Completion returns the entered string; cancellation returns null. The returned panel exposes textarea and close(). A new program evaluation removes the previous panel.

\`\`\`js
KAPPlus.promptCode("Paste offer", "", function(code) {
    if (code !== null) { /* use the entered code */ }
});
\`\`\`` },
  { id: "mesh", category: "Generated assets", signature: "KAPPlus.mesh(encodedData) → Mesh", summary: "Decode a compiler-generated mesh payload.", body: `Normally created by importing an OBJ or GLB. The imported mesh includes vertices, normals, uvs, indices, triangleMaterials, and triangleCount. The payload format is generated by the compiler; author projects should import source assets instead of constructing encoded records manually.` },
  { id: "texture", category: "Generated assets", signature: "KAPPlus.texture(encodedData) → Texture", summary: "Decode an imported PNG and expose image and UV sampling methods.", body: `Normally created by a PNG import. The result exposes width, height, image(), sample(u, v), sampleNearest(u, v), and sampleLinear(u, v). sample uses the filter selected by the texture profile.

compact uses RGB5551 and nearest sampling. high uses resized RGBA8888 and linear sampling. source preserves the original PNG dimensions and decodes asynchronously; whenReady() can wait for this work.` },
  { id: "audio", category: "Generated assets", signature: "KAPPlus.audio(encodedData, byteLength) → AudioAsset", summary: "Create a playback handle for compiler-generated MP3 data.", body: `Normally created by an MP3 import. The handle provides play(), stop(), state, and duration. Call play() from a user interaction. Playback resources from an earlier Khan evaluation are stopped when the runtime restarts.

\`\`\`js
import sound from "./sound.mp3";
export function mouseClicked() { sound.play(); }
\`\`\`` },
  { id: "compileProject", category: "Node API", signature: "compileProject(manifestPath?) → Promise<BuildResult>", summary: "Compile modules, assets, and runtime into local and Khan outputs.", body: `Import from kapplus in Node. The default path is kapplus.json. Returns localProgram, localHtml, khanProgram, and assets without writing build files. The Khan program is lowered to ES5 and optimized for its parser.

\`\`\`js
import { compileProject } from "kapplus";
const output = await compileProject("./kapplus.json");
\`\`\`

Use buildChunkBundle() or publishChunks() before loading a large program in Khan. The complete generated program must not be pasted into the editor.` },
  { id: "analyzeProject", category: "Node API", signature: "analyzeProject(manifestPath?) → Promise<ProjectAnalysis>", summary: "Resolve the manifest, module graph, and assets without emitting a bundle.", body: `Returns the validated manifest, rootDir, manifestPath, raw entry source, flattened sourceWithoutImports, assets, and canonical inputFiles. Named and default imports, re-exports, JSON, and browser-compatible npm packages are bundled. Node built-ins are not available in browser sketches. Errors include the importing file and source location.` },
  { id: "writeProject", category: "Node API", signature: "writeProject(manifestPath?) → Promise<{ analysis, result, outDir }>", summary: "Compile a project and write both target layouts.", body: `Writes local/index.html, local/program.pjs, and khan/program.js below the configured outDir. Returns the analysis, build result, and absolute output directory. The manifest's canvas dimensions are applied before the author's setup callback, which may explicitly override them.` },
  { id: "initializeProject", category: "Node API", signature: "initializeProject(options?) → Promise<InitializedProject>", summary: "Create a starter sketch and manifest without overwriting existing files.", body: `Options are directory, name, and repository. Creates main.js, kapplus.json, README.md, and .gitignore. A repository value configures automatic chunk publishing. Invalid repository syntax and file collisions fail before overwriting user files.` },
  { id: "loadManifest", category: "Node API", signature: "loadManifest(manifestPath) → Promise<LoadedManifest>", summary: "Read and validate kapplus.json, applying documented defaults.", body: `Returns manifestPath, rootDir, and manifest. Errors identify invalid fields. The manifest controls entry, outDir, canvas, asset quality and budgets, and optional public chunk publication. See the Configuration guide for defaults.` },
  { id: "buildChunkBundle", category: "Node API", signature: "buildChunkBundle(options) → Promise<ChunkBundle>", summary: "Create content-addressed JavaScript chunks and a compact Khan bootstrap.", body: `Required options are source, outputDirectory, baseUrl, and projectName. Optional chunkCount or targetChunkBytes controls splitting; liveBootstrapUrl enables the stable first stage, and chunkRevision selects immutable revisions per chunk.

Returns a manifest and bootstrap. The manifest contains the source SHA-256, per-file hashes, byte counts, and build ID. This constructs local publication files without uploading them.` },
  { id: "publishChunks", category: "Node API", signature: "publishChunks(options) → Promise<ChunkPublishResult>", summary: "Publish immutable GitHub releases and verify their jsDelivr bytes.", body: `Pass source, projectName, projectRoot, outDir, publish, and an optional log callback. publish contains repository, branch, and chunks (auto or an integer). Git and an authenticated GitHub CLI are required.

The result includes bootstrap, manifest, repositoryUrl, chunkCommit, publishCommit, releaseTag, and outputDirectory. The stable loader selects the current bootstrap, whose chunks are pinned to immutable tags. Progress and CDN verification complete before success is reported. This API does not save a Khan program.` },
  { id: "startDevServer", category: "Node API", signature: "startDevServer(options?) → Promise<DevServer>", summary: "Watch source and assets with a real Khan preview and diagnostics page.", body: `Options are project, port, host, preview, headless, and onStatus. Defaults are kapplus.json, port 4173, host 127.0.0.1, and preview khan. If the default port is busy, an available port is selected automatically. Explicitly requesting a busy port fails with an actionable error. Port 0 always selects an available port.

\`\`\`js
import { startDevServer } from "kapplus";
const dev = await startDevServer({ project: "./kapplus.json" });
await dev.ready;
console.log(dev.url, dev.getStatus());
// await dev.close() when finished.
\`\`\`

The returned object provides url, ready, getStatus(), rebuild(), and close(). ready waits for the first successful preview, including recovery from an initial source error. The default opens the actual Khan editor and sandbox, inserts only a compact bootstrap, verifies loaded chunk hashes, and performs clean restarts after changes. It never saves a Khan program. preview local explicitly selects the lower-fidelity local ProcessingJS mode.` },
];

export const guides = [
  { id: "modules", title: "JavaScript modules", summary: "Split a sketch into scenes, systems, and shared state.", body: `# JavaScript modules

Use normal named and default imports. Paths resolve relative to the importing file, not the entry. Modules are bundled once, so shared exports retain shared state.

\`\`\`js
// game/player.js
export const player = { x: 100 };
export function update() { player.x += 1; }
\`\`\`

\`\`\`js
// main.js
import { player, update } from "./game/player.js";
export function draw() {
    update();
    background(20);
    ellipse(player.x, 100, 20, 20);
}
\`\`\`

Re-export through index modules, import JSON configuration, or install browser-compatible npm packages. Node APIs such as node:fs cannot run in Khan. Asset imports inside any module are compiled and deduplicated.

An entry can export named ProcessingJS callbacks or assign them globally. A default export from the entry is not the sketch interface; use named callbacks. Default exports from imported modules work normally.` },
  { id: "development", title: "Development and preview fidelity", summary: "Use the actual Khan sandbox and recover from bad edits.", body: `# Development and preview fidelity

\`\`\`sh
npx kapplus install-browser
npx kapplus dev
\`\`\`

The command starts a local diagnostics page and a Chromium window containing the real Khan Academy editor and output frame. Edits to the manifest, modules, and assets rebuild and restart the sandbox. Only a compact loader enters the editor; generated program chunks are delivered through verified CDN routes.

This uses Khan's actual ProcessingJS implementation, iframe origin, browser policies, and deployed runtime version. It does not substitute local mocks for sandbox APIs. The version is shown in the development page. A build error leaves the last successful preview intact; correcting the source triggers recovery.

Use the Khan window for interactive play. The diagnostics page provides a canvas snapshot, rebuild, restart, and focus controls. --headless is useful for automation; --port 0 selects an available port. --preview local explicitly enables a local ProcessingJS compatibility preview, which is not a parity guarantee.

Chromium and internet access are required for the actual sandbox. CI verifies watched edits and error recovery, then compares every canvas pixel with an independent Khan publication run. The SDK does not pin an obsolete copy of Khan; it exercises the deployed sandbox.` },
  { id: "publishing", title: "Publishing and updates", summary: "Paste one loader, then update through immutable CDN releases.", body: `# Publishing and updates

Configure a public repository for your project's chunks. It is separate from the KAP+ library repository.

\`\`\`json
"publish": {
  "repository": "YOUR_USER/my-game-assets",
  "branch": "main",
  "chunks": "auto"
}
\`\`\`

\`\`\`sh
gh auth login
npx kapplus publish > khan-loader.js
\`\`\`

Publishing compiles the project, creates immutable release tags, refreshes the live bootstrap, and verifies served files by SHA-256. Copy the complete compact loader into a new Khan JavaScript / ProcessingJS program. Future successful publications update its downloaded code without replacing the pasted loader.

Generated khan/program.js contains the whole runtime and application. Large generated files must not go into Khan's editor; the loader downloads chunks instead. publish --khan additionally opens the reusable Khan browser profile and creates a saved program. Plain publish leaves that step to you.` },
  { id: "networking", title: "Networking and proxies", summary: "Call HTTPS APIs from a sketch with predictable lifecycle handling.", body: `# Networking and proxies

KAPPlus.createNetwork() obtains the browser networking context lazily. Direct requests retain ordinary CORS restrictions. A small server-side proxy can perform upstream requests and add CORS headers for the Khan origin.

The standalone package includes a deployable Cloudflare Worker in workers/network-proxy. Set its allowed target origins, then deploy with Wrangler. It streams request and response bodies, uses no database or storage binding, and disables request logs by default. See [the proxy starter](https://github.com/B1Fr0st/kapplus/tree/v0.1.2/workers/network-proxy) for configuration and protocol details.

Create one client for a feature, reuse it, and consume or cancel responses. HTTP errors return native Response objects; transport and proxy failures reject. Explicit JSON serialization keeps the wire format predictable. Use an AbortSignal for cancellation or close the client when finished. A Khan restart closes old clients automatically.

Targets are HTTPS. Cookies from the viewer's browser are not copied to an upstream site. Use server-side secrets for API credentials; a token in a public sketch is visible to readers. Allow only the API origins needed by a public program. The reference includes error codes and proxy redirect behavior.

The native bridge depends on Khan's current resource and header behavior. The real-sandbox CI check is intended to catch changes in that environment; the local compatibility preview cannot establish networking parity.` },
  { id: "assets", title: "Assets and quality profiles", summary: "Import meshes, textures, and audio from any module.", body: `# Assets and quality profiles

\`\`\`js
import model from "./model.glb";
import texture from "./texture.png";
import sound from "./sound.mp3";
\`\`\`

OBJ and GLB meshes are compiled into compact geometry. PNG profiles are compact (RGB5551, nearest), high (resized RGBA8888, linear), and source (original PNG dimensions, asynchronous decode). MP3 source quality preserves original bytes; compact mode may compress larger audio and can require ffmpeg.

Imported texture handles provide image() and UV sampling methods. Source textures are ready before the author's setup callback runs. Imported audio handles provide play() and stop(). Shared imports of the same source file produce one compiled asset.

Changing an imported asset triggers a dev rebuild. Files and media belonging to a game live in that project, outside the library repository.` },
  { id: "configuration", title: "Project configuration", summary: "Understand the manifest, budgets, and target canvas.", body: `# Project configuration

kapplus.json selects an entry file and output directory. The canvas dimensions are applied before the author's setup callback; a deliberate size() in setup can override them.

\`\`\`json
{
  "name": "My project",
  "entry": "main.js",
  "outDir": "dist",
  "canvas": { "width": 400, "height": 400 },
  "assets": {
    "maxTextureSize": 256,
    "textureQuality": "high",
    "maxMeshTriangles": 25000,
    "maxBundleBytes": 75000000,
    "audioQuality": "source"
  }
}
\`\`\`

init chooses high texture quality and source audio quality. A minimal hand-written manifest has the conservative defaults shown below. Publish chunks can be auto or an integer from 1 through 32. Automatic splitting targets roughly 8 MB of source per chunk. The dev output directory must be separate from the source root.` },
];
