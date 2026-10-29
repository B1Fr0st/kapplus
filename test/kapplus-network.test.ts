import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeFor } from "../src/runtime.js";

type Client = {
  fetch(url: string, options?: Record<string, unknown>): Promise<Response>;
  openWebSocket(url: string, options?: Record<string, unknown>): Promise<FakeSocket>;
  close(): void;
};
class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  closes: number[] = [];
  constructor(readonly url: string, readonly protocols?: string[]) { super(); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  fail() { this.dispatchEvent(new Event("error")); }
  send(value: unknown) {
    if (this.readyState !== 1) throw new Error("Socket is not open");
    this.sent.push(value);
  }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  close(code = 1000, reason = "") {
    this.closes.push(code); this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}
type Frame = {
  style: Record<string, string>;
  parentNode?: unknown;
  onload: null | (() => void);
  onerror: null | (() => void);
  setAttribute(name: string, value: string): void;
  contentWindow: { location: { origin: string }; fetch: typeof fetch; WebSocket?: unknown };
};
const clients: Client[] = [];
afterEach(() => { clients.splice(0).forEach((client) => client.close()); });

function runtime(khan = false) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"ok":true}'));
  const frames: Frame[] = [];
  const sockets: FakeSocket[] = [];
  class Socket extends FakeSocket {
    constructor(url: string, protocols?: string[]) { super(url, protocols); sockets.push(this); }
  }
  const document = {
    createElement: () => ({
      style: {}, onload: null, onerror: null, setAttribute() {},
      contentWindow: { location: { origin: "https://www.kasandbox.org" }, fetch: fetchMock, WebSocket: Socket },
    }),
    body: {
      appendChild(frame: Frame) { frame.parentNode = this; frames.push(frame); },
      removeChild(frame: Frame) { frames.splice(frames.indexOf(frame), 1); frame.parentNode = undefined; },
    },
  };
  const nativeWindow = {
    Reflect, Promise, URL, Error, AbortController, ArrayBuffer, Object, Headers, WebSocket: Socket,
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
    frames, sockets, fetchMock, nativeWindow, restart,
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


describe("KAP+ WebSockets", () => {
  it("shares lazy frame initialization with HTTP and returns an open native socket", async () => {
    const fixture = runtime(true);
    const client = fixture.create({ proxyUrl: "https://proxy.example/fetch", proxyToken: "private" });
    const opening = client.openWebSocket("wss://echo.example/socket", { protocols: ["chat.v1"], binaryType: "arraybuffer" });
    const request = client.fetch("https://api.example/data");
    expect(fixture.frames).toHaveLength(1);
    expect(fixture.sockets).toHaveLength(0);
    fixture.frames[0]!.onload!();
    await Promise.resolve();
    const native = fixture.sockets[0]!;
    expect(native.url).toBe("wss://echo.example/socket");
    expect(native.protocols).toEqual(["chat.v1"]);
    expect(native.binaryType).toBe("arraybuffer");
    let resolved = false; void opening.then(() => { resolved = true; });
    await Promise.resolve(); expect(resolved).toBe(false);
    native.open();
    expect(await opening).toBe(native);
    const messages: unknown[] = [];
    native.addEventListener("message", event => messages.push((event as MessageEvent).data));
    const bytes = new Uint8Array([0, 128, 255]);
    native.send("hello"); native.send(bytes); native.message(bytes.buffer);
    expect(native.sent).toEqual(["hello", bytes]);
    expect(messages).toEqual([bytes.buffer]);
    await (await request).text();
    client.close();
    expect(native.readyState).toBe(3);
    expect(fixture.frames).toHaveLength(0);
  });

  it.each([
    ["ws://echo.example", {}], ["https://echo.example", {}], ["/socket", {}],
    ["wss://u:p@echo.example", {}], ["wss://echo.example/#x", {}],
    ["wss://echo.example", { protocols: ["chat", "chat"] }],
    ["wss://echo.example", { protocols: ["bad protocol"] }],
    ["wss://echo.example", { protocols: 3 }],
    ["wss://echo.example", { binaryType: "json" }],
    ["wss://echo.example", { timeoutMs: 0 }],
    ["wss://echo.example", { signal: {} }],
    ["wss://echo.example", { headers: { Authorization: "Bearer token" } }],
  ])("rejects invalid socket input without I/O: %s", async (url, options) => {
    const fixture = runtime(true);
    await expect(fixture.create().openWebSocket(url, options)).rejects.toMatchObject({ code: "NETWORK_INVALID_REQUEST" });
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.sockets).toHaveLength(0);
  });

  it("supports a single subprotocol and releases closed sockets", async () => {
    const fixture = runtime(); const client = fixture.create();
    const opening = client.openWebSocket("wss://echo.example", { protocols: "chat" });
    await Promise.resolve(); const socket = fixture.sockets[0]!;
    expect(socket.protocols).toEqual(["chat"]); socket.open(); await opening;
    socket.close(3000, "finished"); client.close();
    expect(socket.closes).toEqual([3000]);
  });

  it("times out initialization and handshakes without a late connection", async () => {
    const fixture = runtime(true); const client = fixture.create();
    await expect(client.openWebSocket("wss://echo.example", { timeoutMs: 10 })).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    fixture.frames[0]!.onload!(); await Promise.resolve();
    expect(fixture.sockets).toHaveLength(0);
    const failure = expect(client.openWebSocket("wss://echo.example", { timeoutMs: 10 })).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    await failure; expect(fixture.sockets[0]!.readyState).toBe(3);
  });

  it("rejects failed and prematurely closed handshakes", async () => {
    const fixture = runtime(); const client = fixture.create();
    const failed = expect(client.openWebSocket("wss://echo.example")).rejects.toMatchObject({ code: "WEBSOCKET_CONNECTION_FAILED" });
    await Promise.resolve(); fixture.sockets[0]!.fail(); await failed;
    const closed = expect(client.openWebSocket("wss://echo.example")).rejects.toMatchObject({ code: "WEBSOCKET_CONNECTION_FAILED", closeCode: 1008 });
    await Promise.resolve(); fixture.sockets[1]!.close(1008, "denied"); await closed;
  });

  it("aborts pending and open sockets and closes them on a Khan restart", async () => {
    const fixture = runtime(true); const client = fixture.create();
    const aborted = new AbortController(); aborted.abort();
    await expect(client.openWebSocket("wss://echo.example", { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.frames).toHaveLength(0);
    const pendingController = new AbortController();
    const pending = expect(client.openWebSocket("wss://echo.example", { signal: pendingController.signal })).rejects.toMatchObject({ name: "AbortError" });
    fixture.frames[0]!.onload!(); await Promise.resolve(); pendingController.abort(); await pending;
    expect(fixture.sockets[0]!.readyState).toBe(3);
    const controller = new AbortController();
    const opening = client.openWebSocket("wss://echo.example", { signal: controller.signal });
    await Promise.resolve(); fixture.sockets[1]!.open(); await opening;
    controller.abort(); expect(fixture.sockets[1]!.readyState).toBe(3);
    const live = client.openWebSocket("wss://echo.example");
    await Promise.resolve(); fixture.sockets[2]!.open(); await live;
    const unfinished = expect(client.openWebSocket("wss://echo.example")).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); fixture.restart(); await unfinished;
    expect(fixture.sockets.every(socket => socket.readyState === 3)).toBe(true);
    expect(fixture.frames).toHaveLength(0);
    await expect(client.openWebSocket("wss://echo.example")).rejects.toMatchObject({ code: "NETWORK_CLOSED" });
  });

  it("reports unavailable native constructors and failed frames", async () => {
    const fixture = runtime(true); const client = fixture.create();
    const opening = expect(client.openWebSocket("wss://echo.example")).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    fixture.frames[0]!.contentWindow.WebSocket = undefined; fixture.frames[0]!.onload!(); await opening;
    const broken = runtime(true);
    const failure = expect(broken.create().openWebSocket("wss://echo.example")).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    broken.frames[0]!.onerror!(); await failure;
  });
});
