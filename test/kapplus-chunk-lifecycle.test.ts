import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { bootstrapSource, liveBootstrapSource } from "../src/chunks.js";

describe("KAP+ chunk loader lifecycle", () => {
  it("ignores a previous run's chunk completion after a newer run starts", () => {
    const scripts: Array<{ onload: () => void }> = [];
    const started: string[] = [];
    const instance = {};
    // The function factory records program initialization without executing
    // source: the regression concerns asynchronous loader ordering.
    function FunctionType(_scope: string, body: string) {
      return () => { started.push(body); return {}; };
    }
    const nativeWindow = {
      Processing: { getInstanceById: () => instance },
      Object, Reflect, Function: FunctionType,
      __kapplusPublishChunks: { first: ["firstProgram();"], second: ["secondProgram();"] },
    };
    const document = {
      defaultView: nativeWindow,
      createElement: () => ({}),
      head: { appendChild(script: { onload: () => void }) { scripts.push(script); } },
    };
    const sandbox = vm.createContext({ getSound: () => ({ audio: { ownerDocument: document } }) });
    vm.runInContext(bootstrapSource("first", ["https://example.test/first.js"]), sandbox);
    vm.runInContext(bootstrapSource("second", ["https://example.test/second.js"]), sandbox);
    scripts[1]!.onload();
    scripts[0]!.onload();
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("secondProgram();");
    expect(nativeWindow).toMatchObject({ __kapplusLoaderStatus: "ready", __kapplusLoaderBuildId: "second" });
  });

  it("reports initialization failures without marking the build ready", () => {
    let script: { onload(): void };
    function FunctionType() { return () => ({ setup() { throw new Error("broken setup"); } }); }
    const nativeWindow = {
      Processing: { getInstanceById: () => ({}) }, Object, Reflect, Function: FunctionType,
      __kapplusPublishChunks: { failed: ["program();"] },
    };
    const document = {
      defaultView: nativeWindow, createElement: () => ({}),
      head: { appendChild(value: typeof script) { script = value; } },
    };
    const sandbox = vm.createContext({ getSound: () => ({ audio: { ownerDocument: document } }) });
    vm.runInContext(bootstrapSource("failed", ["https://example.test/failed.js"]), sandbox);
    script!.onload();
    expect(nativeWindow).toMatchObject({ __kapplusLoaderStatus: "error: Error: broken setup" });
    expect(nativeWindow).not.toHaveProperty("__kapplusLoaderBuildId");
  });

  it("stops an obsolete live-bootstrap search from scheduling more CDN requests", () => {
    const scripts: Array<{ onload: () => void }> = [];
    const started: string[] = [];
    function FunctionType(_scope: string, body: string) {
      return () => { started.push(body); return {}; };
    }
    const nativeWindow = {
      Processing: { getInstanceById: () => ({}) }, Object, Reflect, Date,
      Function: FunctionType,
      __kapplusCurrentBootstrap: { source: "currentBootstrap();", releasePatch: 1 },
    };
    const document = {
      defaultView: nativeWindow, createElement: () => ({}),
      head: { appendChild(script: { onload: () => void }) { scripts.push(script); } },
    };
    const sandbox = vm.createContext({ getSound: () => ({ audio: { ownerDocument: document } }) });
    const source = liveBootstrapSource("https://cdn.jsdelivr.net/gh/example/test@latest/bootstrap.js");
    vm.runInContext(source, sandbox);
    vm.runInContext(source, sandbox);
    for (let index = 1; index <= 5; index++) scripts[index]!.onload();
    expect(started).toHaveLength(1);
    expect(scripts).toHaveLength(6);
    scripts[0]!.onload();
    expect(scripts).toHaveLength(6);
    expect(started).toHaveLength(1);
  });
});
