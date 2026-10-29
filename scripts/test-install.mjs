import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const npm = process.env.npm_execpath;
assert(npm, "Run this smoke check with npm run test:install");
const library = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-install-"));
const environment = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
async function run(args, cwd = temporary) {
  try {
    const result = await exec(process.execPath, [npm, ...args], { cwd, env: environment, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    throw new Error(`npm ${args.join(" ")} failed:\n${error.stdout || ""}\n${error.stderr || ""}`);
  }
}

try {
  const packed = await run(["pack", "--silent", "--json", "--pack-destination", temporary], library);
  const details = JSON.parse(packed.slice(packed.indexOf("[")))[0];
  const included = new Set(details.files.map(file => file.path));
  for (const required of ["dist/cli.js", "dist/index.js", "docs/networking.md", "workers/network-proxy/worker.mjs", "workers/network-proxy/wrangler.jsonc"]) {
    assert(included.has(required), `Missing standalone package file: ${required}`);
  }
  for (const file of details.files) {
    assert(!/(^|\/)(projects|examples|meshes|programs|\.kapplus|\.git)(\/|$)/.test(file.path), `Application content leaked into package: ${file.path}`);
  }
  const consumer = path.join(temporary, "consumer");
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "commonjs" }));
  const installTarget = process.env.KAPPLUS_INSTALL_URL || path.join(temporary, details.filename);
  await run(["install", "--omit=dev", "--no-audit", "--no-fund", installTarget], consumer);
  const installed = JSON.parse(await fs.readFile(path.join(consumer, "node_modules", "kapplus", "package.json"), "utf8"));
  assert.equal(installed.version, details.version);
  await run(["exec", "--offline", "--", "kapplus", "--help"], consumer);
  await run(["exec", "--offline", "--", "kapplus", "init", "game", "--name", "Installed SDK"], consumer);
  const game = path.join(consumer, "game");
  // Exercise the actual onboarding output before replacing it with a fixture.
  await run(["exec", "--offline", "--", "kapplus", "check", "--project", "game/kapplus.json"], consumer);
  await run(["exec", "--offline", "--", "kapplus", "build", "--project", "game/kapplus.json"], consumer);
  await fs.writeFile(path.join(game, "movement.js"), "export const step = 4;\n");
  await fs.writeFile(path.join(game, "main.js"), 'import { step } from "./movement.js"; export function draw() { background(step); }\n');
  await run(["exec", "--offline", "--", "kapplus", "check", "--project", "game/kapplus.json"], consumer);
  await run(["exec", "--offline", "--", "kapplus", "build", "--project", "game/kapplus.json"], consumer);
  const program = await fs.readFile(path.join(game, "dist", "khan", "program.js"), "utf8");
  assert(program.includes("draw"));
  assert(program.includes("openWebSocket"));
  assert(!/RTCPeerConnection|createPeer|stun:/.test(program), "Removed transport code leaked into the package");
  const probe = `import { compileProject, initializeProject, startDevServer } from 'kapplus';
    if (typeof initializeProject !== 'function') throw new Error('Missing public exports');
    const build = await compileProject('./game/kapplus.json');
    if (!build.khanProgram.includes('draw')) throw new Error('Invalid module build');
    const dev = await startDevServer({project:'./game/kapplus.json',preview:'local',port:0});
    await dev.ready;
    const response = await fetch(dev.url+'/api/status');
    if ((await response.json()).phase !== 'ready') throw new Error('Installed dev server failed');
    await dev.close();`;
  await exec(process.execPath, ["--input-type=module", "-e", probe], { cwd: consumer, env: environment });
  console.log(`Standalone install passed: ${details.filename} (${details.size} bytes). No workspace dependencies or project assets were available.`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
