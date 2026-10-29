import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { minifyKhanProgram, PROCESSING_CALLBACKS } from "./compiler.js";

export interface PublishedChunk {
  file: string;
  bytes: number;
  sha256: string;
  revision?: string;
}

export interface ChunkManifest {
  format: 1;
  project: string;
  buildId: string;
  sourceSha256: string;
  sourceBytes: number;
  bootstrapBytes: number;
  liveBootstrap?: PublishedChunk;
  chunkCount: number;
  chunks: PublishedChunk[];
}

export interface BuildChunkBundleOptions {
  source: string;
  outputDirectory: string;
  baseUrl: string;
  projectName: string;
  chunkCount?: number;
  targetChunkBytes?: number;
  liveBootstrapUrl?: string;
  chunkRevision?: (index: number) => string;
}

function splitEvenly(source: string, count: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < count; index++) {
    const start = Math.floor(source.length * index / count);
    const end = Math.floor(source.length * (index + 1) / count);
    chunks.push(source.slice(start, end));
  }
  return chunks;
}

function chunkWrapper(buildId: string, index: number, source: string): string {
  return `(function(root){var key="__kapplusPublishChunks";var registry=root[key]||` +
    `(root[key]={});var build=registry[${JSON.stringify(buildId)}]||` +
    `(registry[${JSON.stringify(buildId)}]=[]);build[${index}]=${JSON.stringify(source)};})(this);\n`;
}

export function bootstrapSource(buildId: string, chunkUrls: string[]): string {
  const callbackNames = JSON.stringify([...PROCESSING_CALLBACKS]);
  const urls = JSON.stringify(chunkUrls);
  const delegatedCallbacks = PROCESSING_CALLBACKS
    .filter((name) => !["setup", "draw"].includes(name))
    .map((name) => `${name} = function() { loaderDispatch(${JSON.stringify(name)}); };`)
    .join("\n");
  return `
(function() {
var joinLoaderWords = function(first, second) { return first + second; };
var loaderCarrier = getSound("rpg/metal-clink");
var loaderDocument = loaderCarrier.audio[joinLoaderWords("owner", "Document")];
var loaderWindow = loaderDocument[joinLoaderWords("default", "View")];
var loaderGenerationKey = joinLoaderWords("__kapplusLoader", "Generation");
var loaderGeneration = {};
loaderWindow[loaderGenerationKey] = loaderGeneration;
var loaderIsCurrent = function() {
  return loaderWindow[loaderGenerationKey] === loaderGeneration;
};
var loaderRegistryKey = joinLoaderWords("__kapplusPublish", "Chunks");
var loaderBuildId = ${JSON.stringify(buildId)};
var loaderUrls = ${urls};
var loaderCallbacks = ${callbackNames};
var loaderHandlers = null;
var loaderInstance = null;
var loaderScope = null;
var loaderState = "loading";
var loaderSetState = function(value) {
  if (!loaderIsCurrent()) { return; }
  loaderState = value;
  loaderGeneration.state = value;
  loaderWindow[joinLoaderWords("__kapplusLoader", "Status")] = value;
};
loaderSetState(loaderState);
var loaderCompleted = 0;
loaderGeneration.completed = 0;
loaderGeneration.total = loaderUrls.length;
var loaderStart = function() {
  if (!loaderIsCurrent()) { return; }
  var registry = loaderWindow[loaderRegistryKey];
  var chunks = registry && registry[loaderBuildId];
  if (!chunks || chunks.length !== loaderUrls.length) {
    loaderSetState("missing chunks");
    return;
  }
  var ProcessingType = loaderWindow[joinLoaderWords("Process", "ing")];
  var instance = ProcessingType.getInstanceById("output-canvas") || ProcessingType.instances[0];
  var ObjectType = loaderWindow[joinLoaderWords("Ob", "ject")];
  var ReflectType = loaderWindow[joinLoaderWords("Re", "flect")];
  var FunctionType = loaderWindow[joinLoaderWords("Func", "tion")];
  var scope = ObjectType[joinLoaderWords("cre", "ate")](instance);
  loaderInstance = instance;
  loaderScope = scope;
  loaderGeneration.instance = instance;
  loaderGeneration.scope = scope;
  var index;
  for (index = 0; index < loaderCallbacks.length; index++) {
    ObjectType[joinLoaderWords("define", "Property")](scope, loaderCallbacks[index], {
      value: null,
      writable: true,
      configurable: true,
      enumerable: true
    });
  }
  var returns = [];
  for (index = 0; index < loaderCallbacks.length; index++) {
    returns.push("\\\"" + loaderCallbacks[index] + "\\\":typeof " +
      loaderCallbacks[index] + "===\\\"function\\\"?" + loaderCallbacks[index] + ":null");
  }
  var body = "with(p){return(function(){" + chunks.join("") +
    ";return{" + returns.join(",") + "};}).call(p);}";
  var runner = ReflectType[joinLoaderWords("con", "struct")](FunctionType, ["p", body]);
  var handlers = runner(scope);
  loaderHandlers = handlers;
  loaderGeneration.handlers = handlers;
  if (handlers.setup) {
    handlers.setup.call(instance);
  }
  loaderWindow[joinLoaderWords("__kapplusLoader", "BuildId")] = loaderBuildId;
  loaderSetState("ready");
};
var loaderLoadNext = function() {
  if (!loaderIsCurrent()) { return; }
  if (loaderCompleted === loaderUrls.length) {
    var startProgram = loaderStart;
    var reportState = loaderSetState;
    var targetWindow = loaderWindow;
    var joinWords = joinLoaderWords;
    try {
      startProgram();
    } catch (kapplusLoaderFailure) {
      targetWindow[joinWords("__kapplusLoader", "Error")] = kapplusLoaderFailure;
      reportState("error: " + kapplusLoaderFailure);
    }
    return;
  }
  var loaderIndex = loaderCompleted;
  var loaderFile = loaderUrls[loaderIndex].split("/").pop();
  loaderSetState("loading " + loaderFile + " (" + (loaderIndex + 1) + "/" + loaderUrls.length + ")");
  var loaderScript = loaderDocument[joinLoaderWords("create", "Element")]("script");
  loaderScript[joinLoaderWords("s", "rc")] = loaderUrls[loaderIndex];
  loaderScript.__kapplusContinue = loaderLoadNext;
  loaderScript.onload = function() {
    if (this.__kapplusHandled) {
      return;
    }
    this.__kapplusHandled = true;
    var continueLoading = this.__kapplusContinue;
    this.__kapplusContinue = null;
    this.onload = null;
    loaderCompleted++;
    loaderGeneration.completed = loaderCompleted;
    continueLoading();
  };
  loaderScript.onerror = function() {
    loaderSetState("failed " + loaderFile + " (" + (loaderIndex + 1) + "/" + loaderUrls.length + ")");
  };
  loaderDocument[joinLoaderWords("he", "ad")][joinLoaderWords("append", "Child")](loaderScript);
};
loaderLoadNext();
setup = function() { frameRate(30); };
var loaderScreen = function(label, detail, current, total) {
  background(18, 23, 32);
  fill(240);
  textAlign(CENTER, CENTER);
  textSize(20);
  text("KAP+", width / 2, height / 2 - 42);
  fill(170, 190, 214);
  textSize(13);
  text(label, width / 2, height / 2 - 10);
  if (detail) {
    fill(112, 133, 160);
    textSize(11);
    text(detail, width / 2, height / 2 + 12);
  }
  if (total > 0) {
    var barWidth = min(280, width - 80);
    var barX = (width - barWidth) / 2;
    noStroke();
    fill(38, 49, 66);
    rect(barX, height / 2 + 38, barWidth, 7, 4);
    fill(91, 194, 231);
    rect(barX, height / 2 + 38, barWidth * current / total, 7, 4);
  }
};
draw = function() {
  var activeLoader = loaderWindow[loaderGenerationKey];
  if (!activeLoader) { return; }
  var assetStatus = loaderWindow[joinLoaderWords("__kapplusAsset", "Status")];
  if (!activeLoader.handlers) {
    loaderScreen(activeLoader.state, "", activeLoader.completed, activeLoader.total);
    return;
  }
  if (assetStatus && assetStatus.phase !== "ready") {
    loaderScreen(
      "Decompiling asset " + assetStatus.current + " of " + assetStatus.total,
      assetStatus.name,
      assetStatus.current - 1,
      assetStatus.total
    );
    return;
  }
  if (activeLoader.handlers) {
    if (activeLoader.handlers.draw) {
      activeLoader.handlers.draw.call(activeLoader.instance);
    }
    return;
  }
};
var loaderDispatch = function(name) {
  var activeLoader = loaderWindow[loaderGenerationKey];
  if (activeLoader && activeLoader.handlers && activeLoader.handlers[name]) {
    activeLoader.scope.mouseX = mouseX;
    activeLoader.scope.mouseY = mouseY;
    activeLoader.scope.pmouseX = pmouseX;
    activeLoader.scope.pmouseY = pmouseY;
    activeLoader.scope.key = key;
    activeLoader.scope.keyCode = keyCode;
    activeLoader.handlers[name].call(activeLoader.instance);
  }
};
${delegatedCallbacks}
})();
`;
}

export function liveBootstrapSource(bootstrapUrl: string): string {
  const callbackNames = JSON.stringify([...PROCESSING_CALLBACKS]);
  const delegatedCallbacks = PROCESSING_CALLBACKS
    .filter((name) => !["setup", "draw"].includes(name))
    .map((name) => `${name} = function() { liveDispatch(${JSON.stringify(name)}); };`)
    .join("\n");
  return `
(function() {
var liveJoinWords = function(first, second) { return first + second; };
var liveCarrier = getSound("rpg/metal-clink");
var liveDocument = liveCarrier.audio[liveJoinWords("owner", "Document")];
var liveWindow = liveDocument[liveJoinWords("default", "View")];
var liveGenerationKey = liveJoinWords("__kapplusLive", "Generation");
var liveGeneration = {};
liveWindow[liveGenerationKey] = liveGeneration;
var liveIsCurrent = function() {
  return liveWindow[liveGenerationKey] === liveGeneration;
};
var liveRegistryKey = liveJoinWords("__kapplusCurrent", "Bootstrap");
var liveBootstrapUrl = ${JSON.stringify(bootstrapUrl)};
var liveBootstrapUrls = [
  liveBootstrapUrl,
  liveBootstrapUrl.replace("@latest", "@0.0"),
  liveBootstrapUrl.replace("@latest", "@0.0.x"),
  liveBootstrapUrl.replace("@latest", "@*"),
  liveBootstrapUrl.replace("@latest", "@~0.0.0")
];
var liveCallbacks = ${callbackNames};
var liveHandlers = null;
var liveInstance = null;
var liveScope = null;
var liveState = "loading current bootstrap";
var liveSetState = function(value) {
  if (!liveIsCurrent()) { return; }
  liveState = value;
  liveGeneration.state = value;
  liveWindow[liveJoinWords("__kapplusLoader", "Status")] = value;
};
liveSetState(liveState);
var liveBestBootstrap = null;
var liveBestRelease = -1;
var liveBootstrapIndex = 0;
var liveStart = function() {
  if (!liveIsCurrent()) { return; }
  var current = liveWindow[liveRegistryKey];
  if (!current || !current.source) {
    liveSetState("missing current bootstrap");
    return;
  }
  var ProcessingType = liveWindow[liveJoinWords("Process", "ing")];
  var instance = ProcessingType.getInstanceById("output-canvas") || ProcessingType.instances[0];
  var ObjectType = liveWindow[liveJoinWords("Ob", "ject")];
  var ReflectType = liveWindow[liveJoinWords("Re", "flect")];
  var FunctionType = liveWindow[liveJoinWords("Func", "tion")];
  var scope = ObjectType[liveJoinWords("cre", "ate")](instance);
  liveInstance = instance;
  liveScope = scope;
  liveGeneration.instance = instance;
  liveGeneration.scope = scope;
  var index;
  for (index = 0; index < liveCallbacks.length; index++) {
    ObjectType[liveJoinWords("define", "Property")](scope, liveCallbacks[index], {
      value: null,
      writable: true,
      configurable: true,
      enumerable: true
    });
  }
  var returns = [];
  for (index = 0; index < liveCallbacks.length; index++) {
    returns.push("\\\"" + liveCallbacks[index] + "\\\":typeof " +
      liveCallbacks[index] + "===\\\"function\\\"?" + liveCallbacks[index] + ":null");
  }
  var body = "with(p){return(function(){" + current.source +
    ";return{" + returns.join(",") + "};}).call(p);}";
  var runner = ReflectType[liveJoinWords("con", "struct")](FunctionType, ["p", body]);
  liveHandlers = runner(scope);
  liveGeneration.handlers = liveHandlers;
  liveSetState("bootstrap ready");
  if (liveHandlers.setup) {
    liveHandlers.setup.call(instance);
  }
};
var liveLoadNext = function() {
  if (!liveIsCurrent()) { return; }
  if (liveBootstrapIndex === liveBootstrapUrls.length) {
    if (liveBestBootstrap) {
      liveWindow[liveRegistryKey] = liveBestBootstrap;
    }
    try {
      liveStart();
    } catch (kapplusLiveFailure) {
      liveWindow[liveJoinWords("__kapplusLoader", "Error")] = kapplusLiveFailure;
      liveSetState("error: " + kapplusLiveFailure);
    }
    return;
  }
  var candidateIndex = liveBootstrapIndex++;
  liveSetState("checking update " + (candidateIndex + 1) + "/" + liveBootstrapUrls.length);
  var liveScript = liveDocument[liveJoinWords("create", "Element")]("script");
  liveScript[liveJoinWords("s", "rc")] = liveBootstrapUrls[candidateIndex] +
    "?kapplus=" + liveWindow[liveJoinWords("Da", "te")].now() + "-" + candidateIndex;
  liveScript.__kapplusContinue = liveLoadNext;
  liveScript.onload = function() {
    if (this.__kapplusHandled) {
      return;
    }
    this.__kapplusHandled = true;
    var continueLoading = this.__kapplusContinue;
    this.__kapplusContinue = null;
    this.onload = null;
    var candidate = liveWindow[liveRegistryKey];
    if (candidate && candidate.source) {
      var candidateRelease = candidate.releasePatch || 0;
      if (!candidateRelease) {
        var releaseMarker = candidate.source.indexOf("@0.0.");
        if (releaseMarker >= 0) {
          candidateRelease = parseInt(candidate.source.slice(releaseMarker + 5).split("/")[0], 10) || 0;
        }
      }
      if (!liveBestBootstrap || candidateRelease > liveBestRelease) {
        liveBestBootstrap = candidate;
        liveBestRelease = candidateRelease;
      }
    }
    continueLoading();
  };
  liveScript.onerror = function() {
    if (!this.__kapplusHandled) {
      this.__kapplusHandled = true;
      var continueLoading = this.__kapplusContinue;
      this.__kapplusContinue = null;
      this.onerror = null;
      continueLoading();
    }
  };
  liveDocument[liveJoinWords("he", "ad")][liveJoinWords("append", "Child")](liveScript);
};
liveLoadNext();
setup = function() { frameRate(30); };
draw = function() {
  var activeLive = liveWindow[liveGenerationKey];
  if (!activeLive) { return; }
  if (activeLive.handlers) {
    if (activeLive.handlers.draw) {
      activeLive.handlers.draw.call(activeLive.instance);
    }
    return;
  }
  background(18, 23, 32);
  fill(240);
  textAlign(CENTER, CENTER);
  textSize(20);
  text("KAP+", width / 2, height / 2 - 18);
  fill(170, 190, 214);
  textSize(13);
  text(activeLive.state, width / 2, height / 2 + 12);
};
var liveDispatch = function(name) {
  var activeLive = liveWindow[liveGenerationKey];
  if (activeLive && activeLive.handlers && activeLive.handlers[name]) {
    activeLive.scope.mouseX = mouseX;
    activeLive.scope.mouseY = mouseY;
    activeLive.scope.pmouseX = pmouseX;
    activeLive.scope.pmouseY = pmouseY;
    activeLive.scope.key = key;
    activeLive.scope.keyCode = keyCode;
    activeLive.handlers[name].call(activeLive.instance);
  }
};
${delegatedCallbacks}
})();
`;
}

export async function buildChunkBundle(options: BuildChunkBundleOptions): Promise<{
  bootstrap: string;
  manifest: ChunkManifest;
}> {
  const targetChunkBytes = options.targetChunkBytes ?? 8_000_000;
  const chunkCount = options.chunkCount ?? Math.max(
    1,
    Math.min(32, Math.ceil(Buffer.byteLength(options.source) / targetChunkBytes)),
  );
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 32) {
    throw new Error("Chunk count must be an integer between 1 and 32");
  }
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const sourceHash = crypto.createHash("sha256").update(options.source).digest("hex");
  const buildId = sourceHash.slice(0, 16);
  const pieces = splitEvenly(options.source, chunkCount);
  if (pieces.join("") !== options.source) throw new Error("Chunk reconstruction changed the source");

  const chunkDirectory = path.join(options.outputDirectory, "chunks", buildId);
  await fs.mkdir(chunkDirectory, { recursive: true });
  await Promise.all(pieces.map((piece, index) =>
    fs.writeFile(path.join(chunkDirectory, `chunk-${index}.js`), chunkWrapper(buildId, index, piece)),
  ));
  const chunkUrls = pieces.map((_, index) => {
    const chunkBase = options.chunkRevision
      ? baseUrl.replace(/@[^/]+$/, `@${options.chunkRevision(index)}`)
      : baseUrl;
    return `${chunkBase}/chunks/${buildId}/chunk-${index}.js`;
  });
  const currentBootstrap = await minifyKhanProgram(bootstrapSource(buildId, chunkUrls));
  let bootstrap = currentBootstrap;
  let liveBootstrap: PublishedChunk | undefined;
  if (options.liveBootstrapUrl) {
    const releasePatch = Number(baseUrl.match(/@0\.0\.(\d+)$/)?.[1] ?? 0);
    const registeredBootstrap = `(function(root){root.__kapplusCurrentBootstrap={` +
      `buildId:${JSON.stringify(buildId)},releasePatch:${releasePatch},` +
      `source:${JSON.stringify(currentBootstrap)}};})(this);\n`;
    await fs.writeFile(path.join(options.outputDirectory, "bootstrap.js"), registeredBootstrap);
    liveBootstrap = {
      file: "bootstrap.js",
      bytes: Buffer.byteLength(registeredBootstrap),
      sha256: crypto.createHash("sha256").update(registeredBootstrap).digest("hex"),
    };
    bootstrap = await minifyKhanProgram(liveBootstrapSource(options.liveBootstrapUrl));
  }
  await fs.writeFile(path.join(options.outputDirectory, "program.js"), bootstrap);

  const chunks = await Promise.all(pieces.map(async (_, index): Promise<PublishedChunk> => {
    const file = `chunks/${buildId}/chunk-${index}.js`;
    const content = await fs.readFile(path.join(options.outputDirectory, file));
    return {
      file,
      bytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      ...(options.chunkRevision ? { revision: options.chunkRevision(index) } : {}),
    };
  }));
  const manifest: ChunkManifest = {
    format: 1,
    project: options.projectName,
    buildId,
    sourceSha256: sourceHash,
    sourceBytes: Buffer.byteLength(options.source),
    bootstrapBytes: Buffer.byteLength(bootstrap),
    ...(liveBootstrap ? { liveBootstrap } : {}),
    chunkCount,
    chunks,
  };
  await fs.writeFile(
    path.join(options.outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await fs.writeFile(path.join(options.outputDirectory, "README.md"), `# ${options.projectName}

Published by KAP+. Paste \`program.js\` into Khan Academy. When present, the
stable first-stage program loads \`bootstrap.js\`, which selects the current
content-addressed JavaScript chunks through jsDelivr.

- Build ID: \`${buildId}\`
- Original Khan source: ${manifest.sourceBytes.toLocaleString()} bytes
- Khan bootstrap: ${manifest.bootstrapBytes.toLocaleString()} bytes
- Source SHA-256: \`${sourceHash}\`
`);
  return { bootstrap, manifest };
}
