import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/network-proxy/worker.mjs";

const origin = "https://www.kasandbox.org";
const target = "https://api.example.test/data";
const endpoint = "https://proxy.example.test/fetch?url=" + encodeURIComponent(target);
const env = { ALLOWED_TARGET_ORIGINS: "https://api.example.test" };

afterEach(() => vi.restoreAllMocks());

describe("KAP+ network proxy", () => {
  it("answers authenticated-client preflights without a token or upstream call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(new Request(endpoint, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type,x-kapplus-token,authorization",
      },
    }), { ...env, PROXY_TOKEN: "secret" });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("x-kapplus-token");
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams a mutation and binary response, preserving status and separating tokens", async () => {
    // The upstream stream deliberately stays open: returning the response must
    // not wait for the full body, read it as text, or base64-encode it.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; value.enqueue(new Uint8Array([0, 128, 255])); },
    }), {
      status: 201,
      statusText: "Created",
      headers: {
        "Content-Type": "application/octet-stream",
        "Set-Cookie": "upstream=private",
        "Access-Control-Allow-Origin": "https://other.example",
        "X-KAPPlus-Error": "spoofed",
        "X-Upstream": "kept",
      },
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    const request = new Request(endpoint, {
      method: "POST",
      headers: {
        Origin: origin,
        Referer: "https://www.kasandbox.org/private-program",
        Cookie: "worker=session",
        "X-KAPPlus-Token": "proxy-secret",
        Authorization: "Bearer upstream-secret",
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array([255, 0, 17]),
    });
    const response = await worker.fetch(request, { ...env, PROXY_TOKEN: "proxy-secret" });
    const [url, options] = fetch.mock.calls[0]!;
    const headers = options!.headers as Headers;

    expect(url).toBe(target);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(options!.body).toBe(request.body);
    expect(options!.redirect).toBe("manual");
    expect(headers.get("Authorization")).toBe("Bearer upstream-secret");
    for (const name of ["X-KAPPlus-Token", "Origin", "Referer", "Cookie"]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(response.status).toBe(201);
    expect(response.body).toBe(upstream.body);
    expect(response.headers.get("X-Upstream")).toBe("kept");
    expect(response.headers.get("X-KAPPlus-URL")).toBe(target);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.has("X-KAPPlus-Error")).toBe(false);
    controller.close();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
  });

  it.each([
    ["https://api.example.test.evil.test/data", env, 403, "TARGET_NOT_ALLOWED"],
    ["http://api.example.test/data", env, 400, "INVALID_TARGET"],
    ["https://user:password@api.example.test/data", env, 400, "INVALID_TARGET"],
    [target, {}, 403, "TARGET_NOT_ALLOWED"],
    [target, { ALLOWED_TARGET_ORIGINS: "*" }, 503, "PROXY_NOT_CONFIGURED"],
    [target, { ...env, PROXY_TOKEN: "required" }, 401, "UNAUTHORIZED"],
  ])("rejects invalid or unconfigured targets before fetching: %s", async (url, configuration, status, code) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(new Request(
      "https://proxy.example.test/fetch?url=" + encodeURIComponent(url),
      { headers: { Origin: origin } },
    ), configuration);

    expect(response.status).toBe(status);
    expect(response.headers.get("X-KAPPlus-Error")).toBe(code);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects other browser origins and unsupported methods before fetching", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const denied = await worker.fetch(new Request(endpoint, {
      headers: { Origin: "https://www.kasandbox.org.evil.test" },
    }), env);
    const unsupported = await worker.fetch(new Request(endpoint, {
      method: "PROPFIND", headers: { Origin: origin },
    }), env);
    expect(denied.status).toBe(403);
    expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("Allow")).toContain("POST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns redirects without following them or directing the browser outside the proxy", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 307, headers: { Location: "https://other.example.test/new", "Cache-Control": "public, max-age=999" },
    }));
    const response = await worker.fetch(new Request(endpoint, {
      method: "POST", headers: { Origin: origin }, body: "do-not-replay",
    }), env);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]!.redirect).toBe("manual");
    expect(response.status).toBe(307);
    expect(response.headers.has("Location")).toBe(false);
    expect(response.headers.get("X-KAPPlus-Location")).toBe("https://other.example.test/new");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves upstream errors and anonymous browser caching without tagging them as proxy failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", {
      status: 404, headers: { "Cache-Control": "public, max-age=60", Vary: "Accept-Language" },
    }));
    const response = await worker.fetch(new Request(endpoint, { headers: { Origin: origin } }), env);

    expect(response.status).toBe(404);
    expect(response.headers.has("X-KAPPlus-Error")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Vary")).toBe("Accept-Language, Origin");
    expect(await response.text()).toBe("missing");
  });

  it("forwards non-preflight OPTIONS and handles HEAD without a response body", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("upstream"));
    const options = await worker.fetch(new Request(endpoint, { method: "OPTIONS" }), env);
    const head = await worker.fetch(new Request(endpoint, { method: "HEAD" }), env);

    expect(await options.text()).toBe("upstream");
    expect(fetch.mock.calls.map((call) => call[1]!.method)).toEqual(["OPTIONS", "HEAD"]);
    expect(head.body).toBeNull();
  });

  it("allows token-authorized arbitrary HTTPS targets and makes failures readable through CORS", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failed"));
    const response = await worker.fetch(new Request(endpoint, {
      headers: { Origin: origin, "X-KAPPlus-Token": "secret" },
    }), { ALLOWED_TARGET_ORIGINS: "*", PROXY_TOKEN: "secret" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("X-KAPPlus-Error")).toBe("UPSTREAM_FETCH_FAILED");
    expect((await response.json()).error).toBe("UPSTREAM_FETCH_FAILED");
  });
});
