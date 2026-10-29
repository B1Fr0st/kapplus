import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildChunkBundle, liveBootstrapSource, type ChunkManifest } from "./chunks.js";
import { minifyKhanProgram } from "./compiler.js";
import type { KapPlusManifest } from "./types.js";

const execFileAsync = promisify(execFile);

interface CommandFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export interface ChunkPublishResult {
  bootstrap: string;
  manifest: ChunkManifest;
  repositoryUrl: string;
  chunkCommit: string;
  publishCommit: string;
  releaseTag: string;
  outputDirectory: string;
}

async function run(command: string, arguments_: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as CommandFailure;
    const details = [failure.stderr, failure.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `${command} ${arguments_.join(" ")} failed` + (details ? `:\n${details}` : ""),
      { cause: failure },
    );
  }
}

async function ensurePublicRepository(repository: string): Promise<void> {
  try {
    const visibility = await run("gh", ["repo", "view", repository, "--json", "visibility", "--jq", ".visibility"]);
    if (visibility !== "PUBLIC") {
      throw new Error(
        `KAP+ chunk repository ${repository} is ${visibility.toLowerCase()}; jsDelivr requires a public repository.`,
      );
    }
  } catch (error) {
    if (!(error instanceof Error) || !/could not resolve to a repository|not found/i.test(error.message)) {
      throw error;
    }
    await run("gh", [
      "repo",
      "create",
      repository,
      "--public",
      "--description",
      "Immutable KAP+ program chunks",
    ]);
  }
}

async function commitIfChanged(checkout: string, message: string, branch: string): Promise<string> {
  await run("git", ["add", "--all"], checkout);
  const status = await run("git", ["status", "--porcelain"], checkout);
  if (status) await run("git", ["commit", "-m", message], checkout);
  const commit = await run("git", ["rev-parse", "HEAD"], checkout);
  await run("git", ["push", "origin", `HEAD:${branch}`], checkout);
  return commit;
}

async function commitWithoutPush(checkout: string, message: string): Promise<string> {
  await run("git", ["add", "--all"], checkout);
  const status = await run("git", ["status", "--porcelain"], checkout);
  if (status) await run("git", ["commit", "-m", message], checkout);
  return run("git", ["rev-parse", "HEAD"], checkout);
}

async function pushReleaseTag(checkout: string, commit: string, tag: string): Promise<void> {
  await run("git", ["tag", tag, commit], checkout);
  await run("git", ["push", "origin", `refs/tags/${tag}`], checkout);
}

async function verifyCdnChunks(
  repository: string,
  revision: string,
  manifest: ChunkManifest,
  timeoutMs = 60_000,
): Promise<void> {
  for (const chunk of manifest.chunks) {
    const url = `https://cdn.jsdelivr.net/gh/${repository}@${chunk.revision ?? revision}/${chunk.file}`;
    const deadline = Date.now() + timeoutMs;
    let lastProblem = "not requested";
    let verified = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          const details = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 240);
          lastProblem = `HTTP ${response.status}${details ? `: ${details}` : ""}`;
        } else if (!/javascript|text\/plain/i.test(response.headers.get("content-type") ?? "")) {
          lastProblem = `unexpected content type ${response.headers.get("content-type") ?? "unknown"}`;
        } else {
          const bytes = Buffer.from(await response.arrayBuffer());
          const hash = crypto.createHash("sha256").update(bytes).digest("hex");
          if (hash === chunk.sha256) {
            verified = true;
            break;
          }
          lastProblem = `SHA-256 mismatch (${hash})`;
        }
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!verified) {
      throw new Error(`jsDelivr did not serve ${chunk.file} correctly: ${lastProblem}`);
    }
  }
}

async function refreshCdnFile(
  repository: string,
  revision: string,
  file: string,
): Promise<"confirmed" | "throttled" | "partial"> {
  const purgePath = `/gh/${repository}@${revision}/${file}`;
  const purgeUrl = `https://purge.jsdelivr.net/gh/${repository}@${revision}/${file}`;
  const response = await fetch(purgeUrl, { cache: "no-store" });
  if (!response.ok) {
    const details = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 240);
    throw new Error(
      `jsDelivr could not refresh ${file}: HTTP ${response.status}${details ? `: ${details}` : ""}`,
    );
  }
  const result = await response.json().catch(() => null) as null | {
    status?: string;
    paths?: Record<string, { throttled?: boolean; providers?: Record<string, boolean> }>;
  };
  const pathResult = result?.paths?.[purgePath];
  if (result?.status !== "finished" || !pathResult) {
    throw new Error(`jsDelivr did not confirm the refresh of ${file}`);
  }
  // Purge requests are rate-limited independently from normal CDN reads. A
  // throttled or partially propagated response is advisory: the version alias
  // may already resolve to the new release. The hash verification immediately
  // below is the authoritative completion check and continues polling safely.
  if (pathResult.throttled) return "throttled";
  if (Object.values(pathResult.providers ?? {}).some((updated) => !updated)) {
    return "partial";
  }
  return "confirmed";
}

async function verifyCdnFile(
  repository: string,
  revision: string,
  file: { file: string; sha256: string },
  cacheKey: string,
  timeoutMs = 60_000,
  equivalentBuildId?: string,
): Promise<"exact" | "equivalent"> {
  const url = `https://cdn.jsdelivr.net/gh/${repository}@${revision}/${file.file}` +
    `?kapplus=${encodeURIComponent(cacheKey)}`;
  const deadline = Date.now() + timeoutMs;
  let lastProblem = "not requested";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        lastProblem = `HTTP ${response.status}`;
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        const hash = crypto.createHash("sha256").update(bytes).digest("hex");
        if (hash === file.sha256) return "exact";
        if (equivalentBuildId &&
            bytes.toString("utf8").includes(`buildId:${JSON.stringify(equivalentBuildId)}`)) {
          return "equivalent";
        }
        lastProblem = `SHA-256 mismatch (${hash})`;
      }
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`jsDelivr did not refresh ${file.file} correctly: ${lastProblem}`);
}

const LIVE_CDN_REVISIONS = ["latest", "0.0", "0.0.x", "*", "~0.0.0"];

async function findLiveCdnBuild(
  repository: string,
  file: string,
  buildId: string,
  cacheKey: string,
): Promise<string | null> {
  const expected = `buildId:${JSON.stringify(buildId)}`;
  const matches = await Promise.all(LIVE_CDN_REVISIONS.map(async (revision) => {
    try {
      const url = `https://cdn.jsdelivr.net/gh/${repository}@${revision}/${file}` +
        `?kapplus=${encodeURIComponent(cacheKey)}-${encodeURIComponent(revision)}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return null;
      return (await response.text()).includes(expected) ? revision : null;
    } catch {
      return null;
    }
  }));
  return matches.find((revision): revision is string => revision !== null) ?? null;
}

async function copyPublishedOutput(
  checkout: string,
  outputDirectory: string,
  manifest: ChunkManifest,
): Promise<void> {
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(path.join(outputDirectory, "chunks"), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(checkout, "program.js"), path.join(outputDirectory, "program.js")),
    fs.copyFile(path.join(checkout, "bootstrap.js"), path.join(outputDirectory, "bootstrap.js")),
    fs.copyFile(path.join(checkout, "manifest.json"), path.join(outputDirectory, "manifest.json")),
  ]);
  for (const chunk of manifest.chunks) {
    const target = path.join(outputDirectory, chunk.file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const local = path.join(checkout, chunk.file);
    try {
      await fs.copyFile(local, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !chunk.revision) throw error;
      const { stdout } = await execFileAsync("git", ["show", `${chunk.revision}:${chunk.file}`], {
        cwd: checkout,
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
      });
      await fs.writeFile(target, stdout);
    }
    const hash = crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex");
    if (hash !== chunk.sha256) {
      throw new Error(`Published output differs from verified chunk ${chunk.file}`);
    }
  }
}

export async function publishChunks(options: {
  source: string;
  projectName: string;
  projectRoot: string;
  outDir: string;
  publish: NonNullable<KapPlusManifest["publish"]>;
  log?: (message: string) => void;
}): Promise<ChunkPublishResult> {
  const log = options.log ?? (() => undefined);
  const { repository, branch } = options.publish;
  const chunks = options.publish.chunks === "auto"
    ? Math.max(1, Math.min(32, Math.ceil(Buffer.byteLength(options.source) / 8_000_000)))
    : options.publish.chunks;
  await run("gh", ["auth", "status"]);
  await ensurePublicRepository(repository);

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kapplus-publish-"));
  const checkout = path.join(temporaryRoot, "repository");
  try {
    log(`Cloning ${repository}`);
    await run("git", ["clone", `https://github.com/${repository}.git`, checkout]);
    await run("git", ["config", "user.name", "KAP+ Publisher"], checkout);
    await run("git", ["config", "user.email", "kapplus@users.noreply.github.com"], checkout);
    const hasHead = await run("git", ["rev-parse", "--verify", "HEAD"], checkout)
      .then(() => true, () => false);
    if (hasHead) await run("git", ["checkout", branch], checkout);
    else await run("git", ["checkout", "-b", branch], checkout);

    const sourceHash = crypto.createHash("sha256").update(options.source).digest("hex");
    const existingManifest = await fs.readFile(path.join(checkout, "manifest.json"), "utf8")
      .then((value) => JSON.parse(value) as ChunkManifest, () => null);
    if (existingManifest?.sourceSha256 === sourceHash &&
        existingManifest.chunkCount === chunks && existingManifest.liveBootstrap) {
      const releaseTag = (await run(
        "git",
        ["tag", "--points-at", "HEAD", "--sort=-version:refname"],
        checkout,
      )).split(/\r?\n/).find((tag) => /^0\.0\.\d+$/.test(tag));
      if (releaseTag) {
        log(`Build ${existingManifest.buildId} is already uploaded as ${releaseTag}`);
        await verifyCdnFile(
          repository,
          releaseTag,
          existingManifest.liveBootstrap,
          releaseTag,
        );
        const existingLiveRevision = await findLiveCdnBuild(
          repository,
          existingManifest.liveBootstrap.file,
          existingManifest.buildId,
          releaseTag,
        );
        if (!existingLiveRevision) {
          log(`Refreshing live jsDelivr bootstrap (${releaseTag})`);
          const refreshStatus = await refreshCdnFile(
            repository,
            "latest",
            existingManifest.liveBootstrap.file,
          );
          if (refreshStatus !== "confirmed") {
            log(`jsDelivr refresh was ${refreshStatus}; verifying the live alias directly`);
          }
          const refreshedRevision = await findLiveCdnBuild(
            repository,
            existingManifest.liveBootstrap.file,
            existingManifest.buildId,
            `${releaseTag}-refreshed`,
          );
          if (!refreshedRevision) {
            await verifyCdnFile(
              repository,
              "latest",
              existingManifest.liveBootstrap,
              releaseTag,
              60_000,
              existingManifest.buildId,
            );
          }
        } else {
          log(`Live alias @${existingLiveRevision} already selects build ${existingManifest.buildId}`);
        }
        log("Verifying jsDelivr chunks");
        await verifyCdnChunks(repository, releaseTag, existingManifest);
        const outputDirectory = path.resolve(options.projectRoot, options.outDir, "publish");
        await copyPublishedOutput(checkout, outputDirectory, existingManifest);
        const liveBase = `https://cdn.jsdelivr.net/gh/${repository}@latest`;
        const stableBootstrap = await minifyKhanProgram(
          liveBootstrapSource(`${liveBase}/bootstrap.js`),
        );
        await fs.writeFile(path.join(outputDirectory, "program.js"), stableBootstrap);
        const publishCommit = await run("git", ["rev-parse", "HEAD"], checkout);
        return {
          bootstrap: stableBootstrap,
          manifest: existingManifest,
          repositoryUrl: `https://github.com/${repository}`,
          chunkCommit: publishCommit,
          publishCommit,
          releaseTag,
          outputDirectory,
        };
      }
    }

    // Keep only the current build at the branch tip so every tagged jsDelivr
    // package remains below its size limit. Historical releases remain
    // available through their immutable semver tags.
    const chunksDirectory = path.join(checkout, "chunks");
    const previousBuilds = await fs.readdir(chunksDirectory).catch(() => [] as string[]);
    if (previousBuilds.length > 0) {
      log(`Pruning ${previousBuilds.length} superseded chunk build${previousBuilds.length === 1 ? "" : "s"}`);
      await fs.rm(chunksDirectory, { recursive: true, force: true });
    }

    const sourceBytes = Buffer.byteLength(options.source);
    const estimatedChunkBytes = Math.ceil(sourceBytes / chunks) * 1.02 + 512;
    const chunksPerRelease = Math.max(1, Math.floor(44_000_000 / estimatedChunkBytes));
    const releaseCount = Math.ceil(chunks / chunksPerRelease);
    let releasePatch = Math.floor(Date.now() / 1_000);
    const releaseTags: string[] = [];
    while (releaseTags.length < releaseCount) {
      const candidate = `0.0.${releasePatch++}`;
      const exists = await run("git", ["rev-parse", "--verify", `refs/tags/${candidate}`], checkout)
        .then(() => true, () => false);
      if (!exists) releaseTags.push(candidate);
    }
    const releaseTag = releaseTags[releaseTags.length - 1]!;
    const releaseBase = `https://cdn.jsdelivr.net/gh/${repository}@${releaseTag}`;
    const liveBase = `https://cdn.jsdelivr.net/gh/${repository}@latest`;
    const staged = path.join(temporaryRoot, "bundle");
    const published = await buildChunkBundle({
      source: options.source,
      outputDirectory: staged,
      baseUrl: releaseBase,
      projectName: options.projectName,
      chunkCount: chunks,
      liveBootstrapUrl: `${liveBase}/bootstrap.js`,
      chunkRevision: releaseCount > 1
        ? (index) => releaseTags[Math.floor(index / chunksPerRelease)]!
        : undefined,
    });
    const oversizedChunk = published.manifest.chunks.find((chunk) => chunk.bytes > 19_000_000);
    if (oversizedChunk) {
      throw new Error(
        `${oversizedChunk.file} is ${oversizedChunk.bytes.toLocaleString()} bytes. ` +
          `Use publish.chunks: "auto" or increase the numeric value so every jsDelivr file ` +
          `stays below its 20 MB limit.`,
      );
    }
    const publishedBytes = published.manifest.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    const bytesByRelease = new Map<string, number>();
    for (const chunk of published.manifest.chunks) {
      const revision = chunk.revision ?? releaseTag;
      bytesByRelease.set(revision, (bytesByRelease.get(revision) ?? 0) + chunk.bytes);
    }
    for (const [revision, bytes] of bytesByRelease) {
      if (bytes > 49_000_000) {
        throw new Error(`Release ${revision} contains ${bytes.toLocaleString()} bytes of chunks, above the 49 MB jsDelivr limit.`);
      }
    }
    log(`Uploading build ${published.manifest.buildId} (${publishedBytes.toLocaleString()} bytes across ${releaseCount} release${releaseCount === 1 ? "" : "s"})`);
    let publishCommit = "";
    for (let group = 0; group < releaseCount; group++) {
      await fs.rm(path.join(checkout, "chunks"), { recursive: true, force: true });
      if (group === 0) {
        for (const file of ["program.js", "bootstrap.js", "manifest.json", "README.md"]) {
          await fs.rm(path.join(checkout, file), { force: true });
        }
      }
      const first = group * chunksPerRelease;
      const last = Math.min(first + chunksPerRelease, published.manifest.chunks.length);
      for (const chunk of published.manifest.chunks.slice(first, last)) {
        const target = path.join(checkout, chunk.file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(staged, chunk.file), target);
      }
      if (group === releaseCount - 1) {
        for (const file of ["program.js", "bootstrap.js", "manifest.json", "README.md"]) {
          await fs.copyFile(path.join(staged, file), path.join(checkout, file));
        }
      }
      publishCommit = await commitWithoutPush(
        checkout,
        `Publish KAP+ build ${published.manifest.buildId} part ${group + 1}/${releaseCount}`,
      );
      await pushReleaseTag(checkout, publishCommit, releaseTags[group]!);
    }
    await run("git", ["push", "origin", `HEAD:${branch}`], checkout);

    if (!published.manifest.liveBootstrap) {
      throw new Error("KAP+ did not generate the live bootstrap");
    }
    log(`Waiting for jsDelivr release ${releaseTag}`);
    await verifyCdnFile(
      repository,
      releaseTag,
      published.manifest.liveBootstrap,
      releaseTag,
    );
    log(`Refreshing live jsDelivr bootstrap (${releaseTag})`);
    const refreshStatus = await refreshCdnFile(
      repository,
      "latest",
      published.manifest.liveBootstrap.file,
    );
    if (refreshStatus !== "confirmed") {
      log(`jsDelivr refresh was ${refreshStatus}; verifying the live alias directly`);
    }
    const liveRevision = await findLiveCdnBuild(
      repository,
      published.manifest.liveBootstrap.file,
      published.manifest.buildId,
      releaseTag,
    );
    if (!liveRevision) {
      await verifyCdnFile(
        repository,
        "latest",
        published.manifest.liveBootstrap,
        releaseTag,
        60_000,
        published.manifest.buildId,
      );
    } else if (liveRevision !== "latest") {
      log(`Live bootstrap confirmed through @${liveRevision}`);
    }
    log("Verifying jsDelivr chunks");
    await verifyCdnChunks(repository, releaseTag, published.manifest);

    const outputDirectory = path.resolve(options.projectRoot, options.outDir, "publish");
    await copyPublishedOutput(checkout, outputDirectory, published.manifest);
    return {
      bootstrap: published.bootstrap,
      manifest: published.manifest,
      repositoryUrl: `https://github.com/${repository}`,
      chunkCommit: publishCommit,
      publishCommit,
      releaseTag,
      outputDirectory,
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
