#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  KHAN_NEW_PROGRAM_URL,
  KhanBrowserSession,
  isKnownKhanConsoleNoise,
} from "./browser-session.js";
import { analyzeProject, writeProject } from "./compiler.js";
import { initializeProject } from "./init.js";
import { publishChunks } from "./publisher.js";
import { startDevServer } from "./dev.js";

interface CliOptions {
  command: string;
  project: string;
  directory: string;
  name?: string;
  repository?: string;
  title?: string;
  timeoutMs: number;
  yes: boolean;
  publishKhan: boolean;
  port: number;
  preview: "khan" | "local";
  headless: boolean;
}

function usage(): string {
  return `KAP+ (kapplus) — local-to-Khan ProcessingJS compiler

Usage:
  kapplus init [directory] [--name "Project name"] [--repository OWNER/REPO]
  kapplus check [--project kapplus.json]
  kapplus build [--project kapplus.json]
  kapplus dev [--project kapplus.json] [--port 4173] [--headless] [--preview local]
  kapplus install-browser
  kapplus docs
  kapplus auth [--timeout 600]
  kapplus publish [--project kapplus.json] [--khan] [--title "Program title"]
  kapplus --help

Authentication:
  publish prints the Khan-ready loader without creating a Khan program. Pass
  --khan to publish through a reusable <project>/.kapplus/khan-profile. Set
  KHAN_USER_DATA_DIR to choose another profile, or KHAN_CDP_URL to attach to an
  already authenticated Chromium browser.
`;
}

export function parseArguments(arguments_: string[]): CliOptions {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return {
      command: "help",
      project: "kapplus.json",
      directory: ".",
      timeoutMs: 120_000,
      yes: false,
      publishKhan: false,
      port: 4173,
      preview: "khan",
      headless: false,
    };
  }
  const command = arguments_[0]!;
  let project = "kapplus.json";
  let directory = ".";
  let hasDirectory = false;
  let name: string | undefined;
  let repository: string | undefined;
  let title: string | undefined;
  let timeoutMs = command === "auth" || command === "publish" ? 10 * 60_000 : 120_000;
  let yes = false;
  let publishKhan = false;
  let port = 4173;
  let preview: "khan" | "local" = "khan";
  let headless = false;
  for (let index = 1; index < arguments_.length; index++) {
    if (arguments_[index] === "--project" && arguments_[index + 1]) {
      project = arguments_[++index]!;
    } else if (arguments_[index] === "--name" && arguments_[index + 1]) {
      name = arguments_[++index]!;
    } else if (arguments_[index] === "--repository" && arguments_[index + 1]) {
      repository = arguments_[++index]!;
    } else if (arguments_[index] === "--title" && arguments_[index + 1]) {
      title = arguments_[++index]!;
    } else if (arguments_[index] === "--timeout" && arguments_[index + 1]) {
      const seconds = Number(arguments_[++index]);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      timeoutMs = Math.round(seconds * 1_000);
    } else if (arguments_[index] === "--yes") {
      yes = true;
    } else if (arguments_[index] === "--khan") {
      publishKhan = true;
    } else if (command === "dev" && arguments_[index] === "--port" && arguments_[index + 1]) {
      port = Number(arguments_[++index]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
    } else if (command === "dev" && arguments_[index] === "--preview" && arguments_[index + 1]) {
      const value = arguments_[++index];
      if (value !== "khan" && value !== "local") throw new Error("--preview must be khan or local");
      preview = value;
    } else if (command === "dev" && arguments_[index] === "--headless") {
      headless = true;
    } else if (command === "init" && !arguments_[index]!.startsWith("-") && !hasDirectory) {
      directory = arguments_[index]!;
      hasDirectory = true;
    } else {
      throw new Error(`Unknown argument: ${arguments_[index]}`);
    }
  }
  return { command, project, directory, name, repository, title, timeoutMs, yes, publishKhan, port, preview, headless };
}

function describeAssets(assets: Awaited<ReturnType<typeof analyzeProject>>["assets"]): string {
  const counts = { mesh: 0, texture: 0, audio: 0 };
  for (const asset of assets) counts[asset.kind]++;
  return `${counts.mesh} mesh, ${counts.texture} texture, ${counts.audio} audio`;
}

function configureReusableKhanSession(projectRoot = process.cwd()): void {
  if (!process.env.KHAN_USER_DATA_DIR && !process.env.KHAN_CDP_URL) {
    process.env.KHAN_USER_DATA_DIR = path.join(projectRoot, ".kapplus", "khan-profile");
  }
}

async function authenticate(options: CliOptions): Promise<void> {
  configureReusableKhanSession();
  const session = new KhanBrowserSession();
  try {
    console.log("Opening Khan Academy. Complete login in the browser window if prompted...");
    await session.open(KHAN_NEW_PROGRAM_URL);
    const wasAuthenticated = await session.isAuthenticated();
    if (!wasAuthenticated) await session.authenticate(options.timeoutMs);
    console.log(wasAuthenticated ? "Khan Academy session is already authenticated." : "Khan Academy login saved.");
  } finally {
    await session.close();
  }
}

async function publish(options: CliOptions): Promise<void> {
  const report = options.publishKhan
    ? (message: string) => console.log(message)
    : (message: string) => console.error(message);
  const built = await writeProject(options.project);
  const publishConfig = built.analysis.manifest.publish;
  if (!publishConfig) {
    throw new Error(
      "Publishing requires a `publish.repository` entry such as " +
        '"B1Fr0st/kapplus-publish" in kapplus.json.',
    );
  }
  const title = options.title?.trim() || built.analysis.manifest.name;
  report(`KAP+ preparing ${title}.`);
  report(`  Built: ${describeAssets(built.result.assets)}`);
  const chunks = await publishChunks({
    source: built.result.khanProgram,
    projectName: built.analysis.manifest.name,
    projectRoot: built.analysis.rootDir,
    outDir: built.analysis.manifest.outDir,
    publish: publishConfig,
    log: (message) => report(`  ${message}`),
  });
  report(
    `  CDN: ${chunks.manifest.chunkCount} chunks verified ` +
      `(${chunks.manifest.sourceBytes.toLocaleString()} source bytes)`,
  );
  if (!options.publishKhan) {
    report("  Khan: not published (pass --khan to create a Khan Academy program)");
    report("  Output: Khan-ready bootstrap follows on stdout");
    process.stdout.write(chunks.bootstrap.endsWith("\n") ? chunks.bootstrap : `${chunks.bootstrap}\n`);
    return;
  }

  configureReusableKhanSession(built.analysis.rootDir);
  const session = new KhanBrowserSession();
  try {
    await session.open(KHAN_NEW_PROGRAM_URL);
    if (!(await session.isAuthenticated())) {
      console.log("  Khan: complete login in the opened browser to continue");
      await session.authenticate(options.timeoutMs);
    }
    const state = await session.setCode(chunks.bootstrap, 1_500);
    if (state.code !== chunks.bootstrap) {
      throw new Error("Khan Academy did not retain the complete generated program; publication stopped.");
    }
    if (state.errors.length > 0) {
      throw new Error(`Khan Academy reported editor errors:\n${state.errors.join("\n")}`);
    }
    await session.waitForKapPlusLoader(Math.min(options.timeoutMs, 60_000));
    const readyState = await session.getState();
    if (readyState.errors.length > 0) {
      throw new Error(`Khan Academy reported editor errors:\n${readyState.errors.join("\n")}`);
    }
    const browserErrors = readyState.console.filter((entry) => {
      return entry.level === "error" && !isKnownKhanConsoleNoise(entry.text);
    });
    if (browserErrors.length > 0) {
      throw new Error(
        `Khan Academy reported runtime errors:\n${browserErrors.map((entry) => entry.text).join("\n")}`,
      );
    }
    console.log("  Khan: loader reached ready with no errors");
    const result = await session.publishNewProgram(title, options.timeoutMs);
    const stateDirectory = path.join(built.analysis.rootDir, ".kapplus");
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.writeFile(
      path.join(stateDirectory, "publish-state.json"),
      `${JSON.stringify({
        format: 1,
        project: built.analysis.manifest.name,
        buildId: chunks.manifest.buildId,
        repository: publishConfig.repository,
        chunkCommit: chunks.chunkCommit,
        publishCommit: chunks.publishCommit,
        releaseTag: chunks.releaseTag,
        khanProgramUrl: result.url,
        publishedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    console.log(`KAP+ published ${result.title} (${result.codeBytes.toLocaleString()} bytes).`);
    console.log(`  Chunks: ${chunks.repositoryUrl}`);
    console.log(`  URL: ${result.url}`);
  } finally {
    await session.close();
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    console.log(usage());
  } else if (options.command === "init") {
    const initialized = await initializeProject({
      directory: options.directory,
      name: options.name,
      repository: options.repository,
    });
    console.log(`KAP+ initialized ${initialized.name}.`);
    console.log(`  Directory: ${initialized.rootDir}`);
    for (const file of initialized.files) console.log(`  Created:   ${file}`);
    console.log("\nNext:");
    if (initialized.rootDir !== process.cwd()) {
      const relative = path.relative(process.cwd(), initialized.rootDir);
      const destination = relative.startsWith("..") ? initialized.rootDir : relative || ".";
      console.log(`  cd ${JSON.stringify(destination)}`);
    }
    console.log("  npx kapplus install-browser");
    console.log("  npx kapplus dev");
  } else if (options.command === "check") {
    const analysis = await analyzeProject(options.project);
    console.log(
      `KAP+ check passed: ${analysis.manifest.name} (${describeAssets(analysis.assets)}).`,
    );
  } else if (options.command === "build") {
    const built = await writeProject(options.project);
    console.log(`KAP+ built ${built.analysis.manifest.name}.`);
    console.log(`  Assets: ${describeAssets(built.result.assets)}`);
    console.log(`  Local:  ${path.join(built.outDir, "local", "index.html")}`);
    console.log(`  Khan:   ${path.join(built.outDir, "khan", "program.js")}`);
  } else if (options.command === "dev") {
    const server = await startDevServer({
      project: options.project, port: options.port, preview: options.preview,
      headless: options.headless,
      onStatus(state) {
        if (state.phase === "building") console.log("KAP+ building…");
        if (state.phase === "ready") console.log(`KAP+ ready: ${state.buildId} (${state.buildMs} ms, ${state.mode} preview)`);
        if (state.phase === "error") console.error(`KAP+ build failed:\n${state.error}`);
      },
    });
    console.log(`KAP+ dev: ${server.url}`);
    console.log(options.preview === "khan"
      ? "Interactive preview uses the actual Khan Academy sandbox; no program is saved."
      : "Local ProcessingJS compatibility preview; use the default Khan mode for publication parity.");
    const shutdown = () => {
      void server.close().catch(error => { console.error(error); process.exitCode = 1; });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } else if (options.command === "auth") {
    await authenticate(options);
  } else if (options.command === "install-browser") {
    const require = createRequire(import.meta.url);
    const browserCli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [browserCli, "install", "chromium"], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Chromium installation exited with code ${code}`)));
    });
  } else if (options.command === "docs") {
    const metadata = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(metadata.homepage || "https://kapplus-docs.aquaboot22.chatgpt.site");
  } else if (options.command === "publish") {
    await publish(options);
  } else {
    throw new Error(`Unknown command: ${options.command}\n\n${usage()}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
