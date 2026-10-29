import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startDevServer, type DevOptions, type DevServer } from "../src/dev.js";

const servers: DevServer[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(broken = false, options: DevOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-dev-test-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "kapplus.json"), JSON.stringify({ name: "Watch fixture", entry: "main.js", outDir: "dist" }));
  await fs.writeFile(path.join(root, "main.js"), broken
    ? 'import { level } from "./missing.js"; export function draw() { background(level); }'
    : 'import { level } from "./scene.js"; export function draw() { background(level); }');
  await fs.writeFile(path.join(root, "scene.js"), "export const level = 3;");
  const server = await startDevServer({ project: path.join(root, "kapplus.json"), preview: "local", port: 0, ...options });
  servers.push(server);
  return { server, root };
}

describe("development server", { timeout: 20000 }, () => {
  it("selects an available port when the default port is occupied", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve() : reject(error));
      blocker.listen(4173, "127.0.0.1", resolve);
    });
    try {
      const { server } = await fixture(false, { port: undefined });
      await server.ready;
      expect(new URL(server.url).port).not.toBe("4173");
      expect((await fetch(server.url + "/api/status")).status).toBe(200);
    } finally {
      if (blocker.listening) await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
    }
  });

  it("reports an explicitly requested busy port without switching ports", async () => {
    const blocker = http.createServer();
    await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    try {
      await expect(fixture(false, { port: address.port })).rejects.toThrow(/already in use.*--port 0/);
      expect(blocker.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
    }
  });

  it("watches imported modules, retains a successful build on error, and recovers", async () => {
    const { server, root } = await fixture();
    await server.ready;
    const initial = server.getStatus().buildId;
    const response = await fetch(server.url + "/api/status");
    expect(await response.json()).toMatchObject({ phase: "ready", mode: "local", inputCount: 2 });
    expect((await fetch(server.url + "/")).status).toBe(200);
    expect((await (await fetch(server.url + "/local/")).text())).toContain("Watch fixture");

    // An entry edit immediately after startup must not be lost to native event
    // coalescing. This also exercises missing-import recovery after a good build.
    await fs.writeFile(path.join(root, "main.js"), 'import { level } from "./added.js"; export function draw() { background(level); }');
    await expect.poll(() => server.getStatus().phase, { timeout: 10000 }).toBe("error");
    await fs.writeFile(path.join(root, "added.js"), 'export { level } from "./scene.js";');
    await expect.poll(() => server.getStatus().phase, { timeout: 10000 }).toBe("ready");

    await fs.writeFile(path.join(root, "scene.js"), "export const level = 7;");
    await expect.poll(() => server.getStatus().phase === "ready" && server.getStatus().buildId !== initial,
      { timeout: 10000 }).toBe(true);
    const successful = server.getStatus().buildId;
    const builtFile = path.join(root, "dist", "khan", "program.js");
    const previous = await fs.readFile(builtFile, "utf8");
    await fs.writeFile(path.join(root, "scene.js"), "export const level = ;");
    await expect.poll(() => server.getStatus().phase, { timeout: 10000 }).toBe("error");
    expect(server.getStatus().error).toContain("scene.js");
    expect(await fs.readFile(builtFile, "utf8")).toBe(previous);

    await fs.writeFile(path.join(root, "scene.js"), 'export { level } from "./new-module.js";');
    await fs.writeFile(path.join(root, "new-module.js"), "export const level = 11;");
    await expect.poll(() => server.getStatus().phase === "ready" && server.getStatus().buildId !== successful,
      { timeout: 10000 }).toBe(true);
    expect(server.getStatus().inputCount).toBe(4);
  });

  it("protects local actions and files, supports explicit rebuilds, and shuts down", async () => {
    const { server } = await fixture();
    await server.ready;
    const denied = await fetch(server.url + "/api/rebuild", { method: "POST", headers: { Origin: "https://foreign.example" } });
    expect(denied.status).toBe(403);
    expect((await fetch(server.url + "/local/%2e%2e%2fkapplus.json")).status).toBe(403);
    const rebuilt = await fetch(server.url + "/api/rebuild", { method: "POST" });
    expect(await rebuilt.json()).toMatchObject({ phase: "ready" });
    await server.close();
    await server.close();
    await expect(fetch(server.url + "/api/status")).rejects.toThrow();
  });

  it("starts with diagnostics for a broken entry and becomes ready when fixed", async () => {
    const { server, root } = await fixture(true);
    await expect.poll(() => server.getStatus().phase, { timeout: 10000 }).toBe("error");
    expect(server.getStatus().error).toContain("missing.js");
    await fs.writeFile(path.join(root, "missing.js"), "export const level = 21;");
    expect(await server.ready).toMatchObject({ phase: "ready", inputCount: 2 });
  });
});
