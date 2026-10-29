// Stateless HTTP proxy: one upstream fetch, streaming bodies, no storage.
const METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const METHOD_SET = new Set(METHODS.split(", "));
const HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

function entries(value) {
  return (value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function cleanHeaders(source, response = false) {
  const headers = new Headers(source);
  // Connection can nominate additional hop-by-hop headers.
  for (const name of entries(headers.get("connection"))) headers.delete(name);
  for (const name of HOP_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-kapplus-") ||
        name.startsWith("access-control-") ||
        (!response && name.startsWith("sec-"))) headers.delete(name);
  }
  for (const name of response
    ? ["set-cookie", "set-cookie2", "location"]
    : ["host", "content-length", "cookie", "origin", "referer"]) {
    headers.delete(name);
  }
  return headers;
}

function cors(headers, origin) {
  if (!origin) return;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "*");
  const vary = entries(headers.get("vary"));
  if (!vary.some((name) => /^(origin|\*)$/i.test(name))) vary.push("Origin");
  headers.set("Vary", vary.join(", "));
}

function failure(status, code, message, origin = "") {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-KAPPlus-Error": code,
  });
  cors(headers, origin);
  return new Response(JSON.stringify({ error: code, message }), { status, headers });
}

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = entries(env.ALLOWED_ORIGINS || "https://www.kasandbox.org");
    if (origin && !allowedOrigins.includes(origin)) {
      return failure(403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed.");
    }
    const endpoint = new URL(request.url);
    if (endpoint.pathname !== "/fetch") {
      return failure(404, "NOT_FOUND", "Use /fetch?url=HTTPS_URL.", origin);
    }
    if (!METHOD_SET.has(request.method)) {
      const response = failure(405, "METHOD_NOT_ALLOWED", "Unsupported HTTP method.", origin);
      response.headers.set("Allow", METHODS);
      return response;
    }
    if (request.method === "OPTIONS" && request.headers.has("Access-Control-Request-Method")) {
      if (!METHOD_SET.has(request.headers.get("Access-Control-Request-Method"))) {
        return failure(405, "METHOD_NOT_ALLOWED", "Unsupported HTTP method.", origin);
      }
      // Preflights do not carry the proxy token and never contact upstream.
      const headers = new Headers({
        "Access-Control-Allow-Methods": METHODS,
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
      });
      cors(headers, origin);
      const requested = request.headers.get("Access-Control-Request-Headers");
      if (requested) headers.set("Access-Control-Allow-Headers", requested);
      headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      return new Response(null, { status: 204, headers });
    }
    if (env.PROXY_TOKEN && request.headers.get("X-KAPPlus-Token") !== env.PROXY_TOKEN) {
      return failure(401, "UNAUTHORIZED", "Proxy token is missing or invalid.", origin);
    }
    let target;
    try {
      target = new URL(endpoint.searchParams.get("url") || "");
      if (target.protocol !== "https:" || target.username || target.password || target.hash) {
        throw new Error("Invalid target");
      }
    } catch {
      return failure(400, "INVALID_TARGET", "Provide an absolute HTTPS URL without credentials or a fragment.", origin);
    }
    const allowedTargets = entries(env.ALLOWED_TARGET_ORIGINS);
    if (!allowedTargets.includes(target.origin) && !allowedTargets.includes("*")) {
      return failure(403, "TARGET_NOT_ALLOWED", "Target origin is not allowed.", origin);
    }
    // A wildcard target proxy needs access control even for non-browser callers.
    if (allowedTargets.includes("*") && !env.PROXY_TOKEN) {
      return failure(503, "PROXY_NOT_CONFIGURED", "Wildcard targets require PROXY_TOKEN.", origin);
    }
    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers: cleanHeaders(request.headers),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        signal: request.signal,
      });
    } catch {
      return failure(502, "UPSTREAM_FETCH_FAILED", "Upstream request failed.", origin);
    }
    const headers = cleanHeaders(upstream.headers, true);
    headers.set("X-KAPPlus-URL", target.href);
    const location = upstream.headers.get("Location");
    if (location) {
      try { headers.set("X-KAPPlus-Location", new URL(location, target).href); } catch {}
    }
    // Preserve upstream browser caching only for anonymous, cookie-free GET/HEAD.
    if (!["GET", "HEAD"].includes(request.method) || env.PROXY_TOKEN ||
        request.headers.has("Authorization") || upstream.headers.has("Set-Cookie") ||
        upstream.headers.has("Set-Cookie2") ||
        (upstream.status >= 300 && upstream.status < 400)) {
      headers.set("Cache-Control", "no-store");
    }
    cors(headers, origin);
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
