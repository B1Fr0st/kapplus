# KAP+ networking API

`KAPPlus.createNetwork()` is available in the local and Khan runtimes. A reusable
[Cloudflare Worker starter](../workers/network-proxy) is included in the package.
Deploy it with the exact target API origins required by your project.

## Author API

```js
var network = KAPPlus.createNetwork({
    proxyUrl: "https://YOUR_PROXY.workers.dev/fetch",
    timeoutMs: 15000
});

network.fetch("https://httpbin.org/anything").then(function(response) {
    if (!response.ok) {
        throw new Error("HTTP " + response.status);
    }
    return response.json();
}).then(function(data) {
    // Update program state here; draw() can display it.
});

network.fetch("https://httpbin.org/anything", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ score: 120 })
}).then(function(response) {
    return response.json();
});

```

Call `network.close()` when finished with the client to abort outstanding work
and close its WebSockets, then release its native frame.

```ts
interface NetworkOptions {
    proxyUrl?: string;   // Absolute HTTPS /fetch endpoint; omit for direct fetch.
    proxyToken?: string; // Optional X-KAPPlus-Token, used only with a proxy.
    timeoutMs?: number;  // Default 15000; time limit until HTTP headers or socket OPEN.
}

interface NetworkRequest {
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | ArrayBufferView | Blob;
    signal?: AbortSignal;
    cache?: RequestCache;
    timeoutMs?: number;
}

interface WebSocketOptions {
    protocols?: string | string[];
    binaryType?: "blob" | "arraybuffer";
    signal?: AbortSignal;
    timeoutMs?: number;
}

interface NetworkClient {
    fetch(url: string, options?: NetworkRequest): Promise<Response>;
    openWebSocket(url: string, options?: WebSocketOptions): Promise<WebSocket>;
    close(): void;
}
```

- Construction is synchronous and does no I/O. The first HTTP or WebSocket operation lazily
  initializes the context; simultaneous calls share initialization. Requests
  wait for initialization, with the same timeout covering that wait.
- Only absolute HTTPS target URLs are accepted initially. GET and HEAD reject
  request bodies. Objects are not implicitly JSON encoded. Callers explicitly
  choose their content type and serialization.
- The response is a native `Response`: `ok`, `status`, `headers`, `body`,
  `text()`, `json()`, `blob()`, and `arrayBuffer()` work normally. Bodies are
  consumed once. HTTP failures, including upstream 404/500, resolve normally.
- Fetch/network failures reject. Initialization failure rejects with an Error
  whose `code` is `NETWORK_UNAVAILABLE`; timeout uses `NETWORK_TIMEOUT`;
  Worker-generated failures use `PROXY_ERROR` and retain the Worker's HTTP
  status and error code. Abort or `close()` rejects pending calls with
  `AbortError`. Reusing a closed client rejects with `NETWORK_CLOSED`.
- Timeouts stop once response headers arrive. An explicit abort signal or
  `close()` can also stop an unfinished response body. Restarting a Khan program
  closes its previous clients, aborts their requests, and releases their frames,
  following the existing audio registry pattern.
- Chunk loaders ignore obsolete run generations, so a late CDN response from an
  earlier evaluation cannot initialize that program again and close the current
  client's network context.
- There are no automatic retries, polling, or fallback between proxy and direct
  transport. This avoids duplicate mutations and unexpected Worker requests.
- Redirects are manual in this first version. Read `X-KAPPlus-Location` on a
  proxied 3xx response and make an explicit next request if desired. The SDK
  forces the browser's redirect mode to `manual` for direct requests too;
  cross-origin direct redirects may be opaque. Do not automatically reuse an
  Authorization header for a different origin.
- Proxy requests use `credentials: "omit"`. Explicit target Authorization
  headers are supported. Browser login cookies and upstream Set-Cookie are not
  carried through the proxy. Browser-forbidden headers, multipart FormData,
  Request objects, and streaming uploads are outside this initial author API.
- `cache` controls the browser-to-Worker fetch. The browser may serve a fresh,
  cacheable GET response without invoking the Worker. The returned `url` and
  `redirected` describe the proxy exchange; `X-KAPPlus-URL` identifies the
  upstream URL. The SDK preserves the browser response URL and redirect metadata.

## WebSockets

```js
var network = KAPPlus.createNetwork();
network.openWebSocket("wss://echo.websocket.org", {
    protocols: [],
    binaryType: "arraybuffer",
    timeoutMs: 15000
}).then(function(socket) {
    socket.onmessage = function(event) { /* event.data is text or binary */ };
    socket.onerror = function(event) { /* connection error after OPEN */ };
    socket.onclose = function(event) { /* event.code and event.reason */ };
    socket.send("hello");
}).catch(function(error) {
    // Initialization, timeout, cancellation, or handshake failure.
});
```

The promise resolves only in the OPEN state and returns the native WebSocket.
Use its standard send(), close(), readyState, bufferedAmount, protocol, and event
APIs. Text and binary messages retain their native representation; there is no
implicit JSON conversion or automatic reconnect. The binaryType option defaults
to the browser's blob behavior; arraybuffer selects ArrayBuffer messages.

Only absolute WSS URLs without credentials or fragments are accepted.
Subprotocols must be valid, unique protocol tokens. Invalid input rejects with
NETWORK_INVALID_REQUEST before opening a frame. Unsupported custom headers
are rejected; browser Origin and cookie rules govern the handshake.

WebSockets connect directly to their WSS URL. The HTTP proxyUrl and proxyToken
options apply only to fetch(), and the included /fetch Worker is an HTTP proxy.
To use a WebSocket relay, supply its WSS endpoint as the socket URL.

Timeouts cover initialization and the handshake and stop at OPEN. Abort signals
remain active for the socket lifetime. Handshake errors and closes before OPEN
reject with WEBSOCKET_CONNECTION_FAILED; early close errors include closeCode
and closeReason. Other errors use NETWORK_UNAVAILABLE, NETWORK_TIMEOUT,
NETWORK_INVALID_REQUEST, and NETWORK_CLOSED. Cancellation and client close
reject pending connections with AbortError; after OPEN they close the socket.
Client close and Khan restart close all tracked sockets and release the frame.

## Runtime context

Khan's existing bridge obtains the native document through
`getSound(...).audio.ownerDocument`, then its `defaultView`. Its main window's
fetch is constrained by the ProcessingJS Content Security Policy.

The verified alternative is a hidden same-origin iframe navigated to
`https://www.kasandbox.org/programming-images/space/planet.png`. Currently this
image response has no CSP and its document's `contentWindow.fetch()` can make
external requests. This was checked on 2026-10-28 with a compact ProcessingJS
fixture: an external GET and POST both returned HTTP 200, and the POST body was
echoed correctly. Blob workers and srcdoc frames inherited the restrictive
policy and did not provide the same behavior.

The runtime keeps native names behind the existing dynamic property access
bridge, retains each live frame until client close/restart, and bounds
initialization with a timeout. It verifies same-origin access and a callable
fetch after frame load. The first requested operation is also the connectivity
check; there is no extra health request. A blocked frame or changed CSP surfaces
as an error. This relies on Khan's current resource and header behavior. Local
preview uses its native window directly and honors the same proxy configuration.

Response bodies pass through a client-side ReadableStream so completion and
cancellation release request state while an unfinished body remains abortable.
The returned object is a native Response with its original URL, redirect, and
type metadata preserved. This does not buffer or copy the whole body.

Direct mode retains ordinary browser CORS restrictions. Proxy mode routes the
request through the Worker, which makes the upstream request server-side and
adds browser-facing CORS headers.

## Worker wire protocol

```http
POST /fetch?url=https%3A%2F%2Fhttpbin.org%2Fanything
Origin: https://www.kasandbox.org
Content-Type: application/json
X-KAPPlus-Token: optional-proxy-token

{"score":120}
```

The outer method, body, and ordinary request headers are the upstream method,
body, and headers. No JSON envelope or Base64 encoding is used. The proxy token,
browser Origin/Referer/Cookie, hop-by-hop headers, and other `X-KAPPlus-*`
control headers are removed before forwarding. One accepted call makes one
upstream fetch with redirects disabled.

The Worker returns the upstream status, status text, headers, and body stream,
except for transport headers, cookies, upstream CORS headers, and reserved
`X-KAPPlus-*` headers. It adds:

| Header | Meaning |
| --- | --- |
| `X-KAPPlus-URL` | Upstream URL used by this request. |
| `X-KAPPlus-Location` | Absolute redirect target, if upstream supplied Location. |
| `X-KAPPlus-Error` | Present only for Worker-generated failures. |

Upstream Location is moved to `X-KAPPlus-Location`, so the browser cannot follow
a redirect outside the proxy automatically. CORS exposes all readable headers
for the credential-free request. OPTIONS carrying
Access-Control-Request-Method is a browser preflight; other OPTIONS requests
are forwarded upstream.

Worker errors have a JSON `{ error, message }` body, an `X-KAPPlus-Error` code,
and `Cache-Control: no-store`. An accepted browser origin receives CORS headers
on errors too. The SDK tests that error header before returning a native
Response to author code. Example codes include `INVALID_TARGET`,
`TARGET_NOT_ALLOWED`, `UNAUTHORIZED`, and `UPSTREAM_FETCH_FAILED`.

See the [Worker README](../workers/network-proxy/README.md) for configuration,
cost behavior, and direct native-fetch examples that work without the
SDK.
