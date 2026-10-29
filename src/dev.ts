import crypto from "node:crypto";
import fs from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import path from "node:path";
import { watch } from "chokidar";
import { KhanBrowserSession, isKnownKhanConsoleNoise } from "./browser-session.js";
import { buildChunkBundle } from "./chunks.js";
import { writeProject } from "./compiler.js";
import { devPage } from "./dev-page.js";
import { loadManifest } from "./manifest.js";

export interface DevState {
  phase: "starting" | "building" | "ready" | "error" | "closed";
  mode: "khan" | "local";
  name?: string;
  buildId?: string;
  buildMs?: number;
  inputCount?: number;
  sourceBytes?: number;
  bootstrapBytes?: number;
  chunkCount?: number;
  error?: string;
  runtime?: { origin: string; url: string; version: string | null };
}

export interface DevOptions {
  project?: string;
  port?: number;
  host?: string;
  preview?: "khan" | "local";
  headless?: boolean;
  onStatus?: (state: DevState) => void;
}

export interface DevServer {
  url: string;
  ready: Promise<DevState>;
  getStatus(): DevState;
  rebuild(): Promise<void>;
  close(): Promise<void>;
}

/** Watches a consumer project; the default preview uses Khan's actual runtime. */
export async function startDevServer(options: DevOptions = {}): Promise<DevServer> {
  const project = path.resolve(options.project || "kapplus.json");
  const root = path.dirname(project);
  const mode = options.preview || "khan";
  if (mode !== "khan" && mode !== "local") throw new Error("preview must be khan or local");
  const port = options.port ?? 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid development port");
  const host = options.host || "127.0.0.1";
  let output = path.join(root, "dist");
  const realRoot = await fs.realpath(root);
  const externalDirectories = new Set<string>();
  try { const loaded = await loadManifest(project); output = path.resolve(root, loaded.manifest.outDir); } catch {}
  const token = crypto.randomBytes(8).toString("hex");
  const chunkRoot = path.join(root, ".kapplus", "dev", token);
  const chunkBase = `https://cdn.jsdelivr.net/kapplus-dev-${token}`;
  const chunks = new Map<string, { file: string; sha256: string }>();
  const snapshots: Array<{ directory: string; files: string[] }> = [];
  const subscribers = new Set<ServerResponse>();
  const session = new KhanBrowserSession({ headless: options.headless });
  let browserReady = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let buildRequested = false;
  let appliedHash: string | undefined;
  let work: Promise<void> | undefined;
  let state: DevState = { phase: "starting", mode };
  let resolveReady: (value: DevState) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<DevState>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const update = (next: Partial<DevState>) => {
    state = { ...state, ...next };
    options.onStatus?.({ ...state });
    const message = `data: ${JSON.stringify(state)}\n\n`;
    for (const subscriber of subscribers) subscriber.write(message);
  };

  const startBrowser = async () => {
    if (browserReady) return;
    await session.open();
    const page = await session.getPage();
    await page.route(`${chunkBase}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname.slice(new URL(chunkBase).pathname.length);
      const item = chunks.get(pathname);
      if (!item) { await route.fulfill({ status: 404, body: "Unknown KAP+ development chunk" }); return; }
      try {
        const body = await fs.readFile(item.file);
        if (crypto.createHash("sha256").update(body).digest("hex") !== item.sha256) {
          await route.fulfill({ status: 500, body: "Development chunk hash mismatch" }); return;
        }
        await route.fulfill({ contentType: "application/javascript; charset=utf-8", body });
      } catch { await route.fulfill({ status: 404, body: "Development chunk expired" }); }
    });
    browserReady = true;
  };

  const buildOnce = async () => {
    const started = performance.now();
    update({ phase: "building", error: undefined });
    try {
      const loaded = await loadManifest(project);
      const nextOutput = path.resolve(root, loaded.manifest.outDir);
      if (root === nextOutput || root.startsWith(nextOutput + path.sep)) {
        throw new Error("Development output must be a separate directory, not the project root or its ancestor");
      }
      output = nextOutput;
      const built = await writeProject(project);
      if (closed) return;
      output = built.outDir;
      if (root === output || root.startsWith(output + path.sep)) {
        throw new Error("Development output must be a separate directory, not the project root or its ancestor");
      }
      for (const file of built.analysis.inputFiles) {
        if (!file.startsWith(realRoot + path.sep) && !file.split(path.sep).includes("node_modules")) {
          const directory = path.dirname(file);
          if (!externalDirectories.has(directory)) { externalDirectories.add(directory); watcher.add(directory); }
        }
      }
      const sourceHash = crypto.createHash("sha256").update(built.result.khanProgram).digest("hex").slice(0, 16);
      let runtime: DevState["runtime"];
      let transport: Partial<DevState> = {};
      if (mode === "khan" && (sourceHash !== appliedHash || !browserReady)) {
        const directory = path.join(chunkRoot, sourceHash);
        const bundle = await buildChunkBundle({
          source: built.result.khanProgram, outputDirectory: directory,
          baseUrl: chunkBase, projectName: built.analysis.manifest.name,
        });
        if (Buffer.byteLength(bundle.bootstrap) > 20000) throw new Error("Development bootstrap exceeded the compact-editor limit");
        transport = { sourceBytes: bundle.manifest.sourceBytes,
          bootstrapBytes: bundle.manifest.bootstrapBytes, chunkCount: bundle.manifest.chunkCount };
        for (const item of bundle.manifest.chunks) {
          chunks.set("/" + item.file, { file: path.join(directory, item.file), sha256: item.sha256 });
        }
        if (!snapshots.some(snapshot => snapshot.directory === directory)) {
          snapshots.push({ directory, files: bundle.manifest.chunks.map(item => "/" + item.file) });
        }
        await startBrowser();
        if (closed) return;
        session.clearConsole();
        const initial = await session.setCode(bundle.bootstrap, 500);
        if (initial.code !== bundle.bootstrap) throw new Error("Khan did not retain the complete compact loader");
        if (initial.errors.length) throw new Error(initial.errors.join("\n"));
        // Khan's editor can retain callback closures when only the bootstrap's
        // build ID changes. A clean restart matches publication semantics.
        const browserPage = await session.getPage();
        for (const frame of browserPage.frames().filter(frame => frame.url().includes("/computer-programming/exec/pjs"))) {
          await frame.evaluate(() => {
            const root = globalThis as typeof globalThis & { __kapplusLoaderStatus?: string; __kapplusLoaderError?: unknown };
            root.__kapplusLoaderStatus = "loading";
            root.__kapplusLoaderError = undefined;
          });
        }
        await session.restart(500);
        await session.waitForKapPlusLoader(30000);
        const current = await session.getState();
        const errors = current.console.filter(entry => entry.level === "error" && !isKnownKhanConsoleNoise(entry.text));
        if (current.errors.length || errors.length) throw new Error([...current.errors, ...errors.map(entry => entry.text)].join("\n"));
        const page = await session.getPage();
        const frame = page.frames().find(candidate => candidate.url().includes("/computer-programming/exec/pjs"));
        if (!frame) throw new Error("Khan output frame was not initialized");
        runtime = await frame.evaluate(() => ({
          origin: location.origin, url: location.href,
          version: new URL(location.href).searchParams.get("v"),
        }));
        while (snapshots.length > 3) {
          const old = snapshots.shift()!;
          for (const file of old.files) chunks.delete(file);
          await fs.rm(old.directory, { recursive: true, force: true });
        }
        appliedHash = sourceHash;
      } else if (mode === "khan") {
        runtime = state.runtime;
      }
      if (closed) return;
      update({ phase: "ready", name: built.analysis.manifest.name, buildId: sourceHash,
        buildMs: Math.round(performance.now() - started), inputCount: built.analysis.inputFiles.length, runtime, ...transport });
      resolveReady!({ ...state });
    } catch (error) {
      if (!closed) update({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const rebuild = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("Development server is closed"));
    if (scheduled) { clearTimeout(scheduled); scheduled = undefined; }
    buildRequested = true;
    if (!work) {
      work = (async () => {
        while (buildRequested && !closed) { buildRequested = false; await buildOnce(); }
      })().finally(() => { work = undefined; });
    }
    return work;
  };

  const watcher = watch(root, {
    ignoreInitial: true,
    // Native file events can coalesce an immediate post-startup edit with the
    // file's creation event. Polling also handles atomic saves and shared drives.
    usePolling: true,
    interval: 200,
    binaryInterval: 500,
    ignored: file => {
      const parts = path.relative(root, file).split(path.sep);
      return parts.some(part => [".git", ".kapplus", "node_modules", "coverage"].includes(part)) ||
        output !== root && !root.startsWith(output + path.sep) && (file === output || file.startsWith(output + path.sep));
    },
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  watcher.on("all", () => {
    if (closed) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => { scheduled = undefined; void rebuild(); }, 60);
  });
  watcher.on("error", error => update({ phase: "error", error: `File watcher: ${String(error)}` }));

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "POST") {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) {
          response.writeHead(403); response.end("Development actions require the local origin"); return;
        }
        if (url.pathname === "/api/rebuild") { await rebuild(); }
        else if (url.pathname === "/api/restart") {
          if (mode === "khan" && browserReady) { await session.restart(500); await session.waitForKapPlusLoader(30000); }
          else await rebuild();
        } else if (url.pathname === "/api/focus" && browserReady) { await (await session.getPage()).bringToFront(); }
        else { response.writeHead(404); response.end("Unknown action"); return; }
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(state)); return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
      if (url.pathname === "/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        response.write(`data: ${JSON.stringify(state)}\n\n`);
        subscribers.add(response);
        request.on("close", () => subscribers.delete(response));
      } else if (url.pathname === "/api/status") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(state));
      } else if (url.pathname === "/api/canvas.png" && browserReady) {
        const page = await session.getPage();
        const frame = page.frames().find(candidate => candidate.url().includes("/computer-programming/exec/pjs"));
        if (!frame) throw new Error("Khan canvas is not available");
        const data = await frame.locator("#output-canvas").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL("image/png"));
        response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); response.end(Buffer.from(data.split(",")[1]!, "base64"));
      } else if (url.pathname.startsWith("/local/")) {
        const relative = decodeURIComponent(url.pathname.slice("/local/".length)) || "index.html";
        const directory = path.join(output, "local");
        const filename = path.resolve(directory, relative);
        if (!filename.startsWith(directory + path.sep)) { response.writeHead(403); response.end(); return; }
        const body = await fs.readFile(filename);
        response.writeHead(200, { "Content-Type": filename.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end(body);
      } else if (url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(devPage);
      } else { response.writeHead(404); response.end("Not found"); }
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  } catch (error) { await watcher.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Development server did not acquire a TCP port");
  const api: DevServer = {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    ready,
    getStatus: () => ({ ...state }),
    rebuild,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        if (scheduled) clearTimeout(scheduled);
        await watcher.close();
        await session.close();
        await work;
        update({ phase: "closed" });
        rejectReady!(new Error("Development server closed before becoming ready"));
        for (const subscriber of subscribers) subscriber.end();
        subscribers.clear();
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
        });
        await fs.rm(chunkRoot, { recursive: true, force: true });
      })();
      return closing;
    },
  };
  // Subscribe before the first build so edits made during startup are retained.
  await new Promise<void>(resolve => watcher.once("ready", resolve));
  void rebuild();
  return api;
}
