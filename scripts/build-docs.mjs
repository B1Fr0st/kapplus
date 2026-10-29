import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, guides } from "../docs/reference.mjs";
import * as exported from "../dist/index.js";
import { runtimeFor } from "../dist/runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] || "docs/dist");
const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
const identifiers = new Set(api.map(item => item.id));
for (const [name, value] of Object.entries(exported)) {
  if (typeof value === "function") assert(identifiers.has(name), `Public Node API ${name} has no reference entry`);
}
const runtimeApi = runtimeFor("khan", false).match(/var makeApi = function\(audio\) \{[\s\S]*?return \(\{([\s\S]*?)\}\);/);
assert(runtimeApi, "Could not inspect sketch API");
for (const match of runtimeApi[1].matchAll(/^\s*(\w+):/gm)) assert(identifiers.has(match[1]), `Sketch API ${match[1]} has no reference entry`);
assert.equal(identifiers.size, api.length, "Duplicate reference identifier");

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-doc-defaults-"));
let defaults;
try {
  const filename = path.join(temporary, "kapplus.json");
  await fs.writeFile(filename, '{"entry":"main.js"}');
  defaults = (await exported.loadManifest(filename)).manifest;
} finally { await fs.rm(temporary, { recursive: true, force: true }); }

const repository = metadata.repository.url.replace(/\.git$/, "");
const data = {
  name: metadata.name, version: metadata.version, description: metadata.description,
  homepage: metadata.homepage, repository, engines: metadata.engines, license: metadata.license || null,
  install: `npm install --save-dev ${repository}/releases/download/v${metadata.version}/${metadata.name}-${metadata.version}.tgz`,
  versions: [{ version: metadata.version, url: `${repository}/releases/tag/v${metadata.version}` }],
  dependencies: Object.entries(metadata.dependencies).map(([name, range]) => ({
    name, range, resolved: lock.packages[`node_modules/${name}`]?.version || null,
    url: `https://www.npmjs.com/package/${name}`,
  })),
  readme: await fs.readFile(path.join(root, "README.md"), "utf8"),
  defaults, api, guides,
};
await fs.mkdir(path.join(output, "assets"), { recursive: true });
for (const filename of ["app.js", "style.css"]) {
  await fs.copyFile(path.join(root, "docs", "site", filename), path.join(output, "assets", filename));
}
const template = (await fs.readFile(path.join(root, "docs", "site", "index.html"), "utf8"))
  .replaceAll("__KAPPLUS_VERSION__", metadata.version);
await fs.writeFile(path.join(output, "index.html"), template.replaceAll("__KAPPLUS_ROOT__", "./"));
const versionDirectory = path.join(output, metadata.name, metadata.version);
await fs.mkdir(versionDirectory, { recursive: true });
await fs.writeFile(path.join(versionDirectory, "index.html"), template.replaceAll("__KAPPLUS_ROOT__", "../../"));
await fs.writeFile(path.join(output, "assets", "package.json"), JSON.stringify(data));
console.log(`Built ${metadata.name} ${metadata.version} docs: ${api.length} API entries, ${guides.length} guides → ${output}`);
