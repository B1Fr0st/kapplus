import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeFor } from "../src/runtime.js";

type Client = {
  fetch(url: string, options?: Record<string, unknown>): Promise<Response>;
  close(): void;
};
type Frame = {
  style: Record<string, string>;
  parentNode?: unknown;
  onload: null | (() => void);
  onerror: null | (() => void);
  setAttribute(name: string, value: string): void;
  contentWindow: { location: { origin: string }; fetch: typeof fetch };
};
const clients: Client[] = [];
afterEach(() => { clients.splice(0).forEach((client) => client.close()); });

function runtime(khan = false) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"ok":true}'));
  const frames: Frame[] = [];
  const document = {
    createElement: () => ({
      style: {}, onload: null, onerror: null, setAttribute() {},
      contentWindow: { location: { origin: "https://www.kasandbox.org" }, fetch: fetchMock },
    }),
    body: {
      appendChild(frame: Frame) { frame.parentNode = this; frames.push(frame); },
      removeChild(frame: Frame) { frames.splice(frames.indexOf(frame), 1); frame.parentNode = undefined; },
    },
  };
  const nativeWindow = {
    Reflect, Promise, URL, Error, AbortController, ArrayBuffer, Object, Headers,
    ReadableStream, Response, setTimeout, clearTimeout, atob,
    location: { origin: "https://www.kasandbox.org" },
    fetch: khan ? vi.fn(() => { throw new Error("Main Khan window is CSP-restricted"); }) : fetchMock,
  };
  const sandbox = vm.createContext({
    window: nativeWindow, document, atob, floor: Math.floor, round: Math.round,
    ARGB: 0, createImage: () => ({}),
    getSound: () => ({ audio: { ownerDocument: { ...document, defaultView: nativeWindow } } }),
  });
  const restart = () => vm.runInContext(runtimeFor(khan ? "khan" : "local", false), sandbox);
  restart();
  return {
    frames, fetchMock, nativeWindow, restart,
    create(options?: Record<string, unknown>): Client {
      const client = sandbox.KAPPlus.createNetwork(options) as Client;
      clients.push(client);
      return client;
    },
  };
}

describe("KAP+ networking", () => {
  it("lazily loads one shared Khan frame and uses its fetch for concurrent calls", async () => {
    const fixture = runtime(true);
    const client = fixture.create();
    expect(fixture.frames).toHaveLength(0);
    const first = client.fetch("https://api.example/one");
    const second = client.fetch("https://api.example/two");
    expect(fixture.frames).toHaveLength(1);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    fixture.frames[0]!.onload!();
    const results = await Promise.all([first, second]);
    expect(await Promise.all(results.map((response) => response.json()))).toEqual([{ ok: true }, { ok: true }]);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.nativeWindow.fetch).not.toHaveBeenCalled();
    client.close();
    expect(fixture.frames).toHaveLength(0);
  });

  it("proxies binary mutations with explicit credentials and returns native HTTP error responses", async () => {
    const fixture = runtime();
    fixture.fetchMock.mockResolvedValue(new Response(new Uint8Array([255, 128, 0]), { status: 409 }));
    const client = fixture.create({ proxyUrl: "https://proxy.example/fetch", proxyToken: "demo-token" });
    const body = new Uint8Array([0, 128, 255]);
    const response = await client.fetch("https://api.example/data?a=1&b=2", {
      method: "PATCH", headers: { Authorization: "Bearer target-token" }, body,
    });
    const [url, init] = fixture.fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get("url")).toBe("https://api.example/data?a=1&b=2");
    expect(init).toMatchObject({ method: "PATCH", credentials: "omit", redirect: "manual", body });
    expect((init!.headers as Headers).get("X-KAPPlus-Token")).toBe("demo-token");
    expect((init!.headers as Headers).get("Authorization")).toBe("Bearer target-token");
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(409);
    expect(response.ok).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 128, 0]));
  });

  it("distinguishes proxy errors from upstream HTTP failures without retrying", async () => {
    const fixture = runtime();
    fixture.fetchMock.mockResolvedValue(new Response('{"error":"TARGET_NOT_ALLOWED"}', {
      status: 403, headers: { "X-KAPPlus-Error": "TARGET_NOT_ALLOWED" },
    }));
    const client = fixture.create({ proxyUrl: "https://proxy.example/fetch" });
    await expect(client.fetch("https://api.example/data")).rejects.toMatchObject({
      code: "PROXY_ERROR", status: 403, proxyCode: "TARGET_NOT_ALLOWED",
    });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["http://api.example/data", {}],
    ["not a URL", {}],
    ["https://user:password@api.example/data", {}],
    ["https://api.example/data#fragment", {}],
    ["https://api.example/data", { method: "GET", body: "unexpected" }],
    ["https://api.example/data", { method: "TRACE" }],
    ["https://api.example/data", { method: "POST", body: { score: 1 } }],
    ["https://api.example/data", { timeoutMs: NaN }],
  ])("rejects invalid input before creating a frame: %s", async (url, options) => {
    const fixture = runtime(true);
    await expect(fixture.create().fetch(url, options)).rejects.toMatchObject({ code: "NETWORK_INVALID_REQUEST" });
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("times out while initialization is pending without making an upstream request", async () => {
    const fixture = runtime(true);
    const client = fixture.create({ timeoutMs: 1000 });
    await expect(client.fetch("https://api.example/data", { timeoutMs: 10 })).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    fixture.frames[0]!.onload!();
    await Promise.resolve();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces frame failure and a closed client", async () => {
    const fixture = runtime(true);
    const client = fixture.create();
    const failure = expect(client.fetch("https://api.example/data")).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    fixture.frames[0]!.onerror!();
    await failure;
    expect(fixture.frames).toHaveLength(0);
    client.close();
    client.close();
    await expect(client.fetch("https://api.example/data")).rejects.toMatchObject({ code: "NETWORK_CLOSED" });
  });

  it("aborts before initialization and when a signal fires during fetch", async () => {
    const fixture = runtime();
    const client = fixture.create();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(client.fetch("https://api.example/data", { signal: alreadyAborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    fixture.fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const failure = expect(client.fetch("https://api.example/data", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await failure;
    expect(fixture.fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("keeps a response body abortable after headers, and closes old clients on Khan restart", async () => {
    const fixture = runtime(true);
    fixture.fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason));
      },
    })));
    const client = fixture.create();
    const pending = client.fetch("https://api.example/stream");
    fixture.frames[0]!.onload!();
    const response = await pending;
    const bodyFailure = expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    fixture.restart();
    await bodyFailure;
    expect(fixture.frames).toHaveLength(0);
    await expect(client.fetch("https://api.example/data")).rejects.toMatchObject({ code: "NETWORK_CLOSED" });
  });
});
