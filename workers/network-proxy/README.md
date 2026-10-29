# Network proxy starter

A stateless Cloudflare Worker for `KAPPlus.createNetwork({ proxyUrl })`.
It forwards one HTTP request per call and streams bodies without a JSON
envelope, Base64 conversion, or response buffering. No storage service or
persistent connection is required; Workers Logs is disabled in the example.

Copy this directory into your project, edit `wrangler.jsonc` for the exact API
origins you need, then run:

```sh
npx wrangler@4 dev
npx wrangler@4 deploy
```

Use the deployed `/fetch` endpoint as your client's proxyUrl. The starter name
is `kapplus-project-proxy`; choose a distinct Worker name for each independent
project. The default target list allows httpbin and jsDelivr for verification.

Browser origins and HTTPS target origins are comma-separated exact origins.
An empty target list denies every target. Optional access control uses a
`PROXY_TOKEN` secret and the client's proxyToken option. A wildcard target list
requires a token. Browser Origin filtering alone is not authentication, and
tokens embedded in a public sketch are public too. Prefer a narrow target list
for public programs; keep upstream credentials on the server.

The protocol is `METHOD /fetch?url=ENCODED_HTTPS_URL`, with the upstream body and
ordinary headers passed directly. The token, browser Origin/Referer/Cookie,
control headers, and hop-by-hop headers are removed before forwarding.
Upstream statuses and streamed bodies are preserved. Set-Cookie is stripped;
Location is exposed as `X-KAPPlus-Location` for explicit redirect handling.
Worker-generated errors include `X-KAPPlus-Error` and a JSON error body.

Preflights make no upstream request and advertise a one-day cache lifetime.
Anonymous GET/HEAD responses preserve upstream browser cache headers;
authenticated responses, mutations, redirects, and errors use no-store.

See the [networking contract](../../docs/networking.md) and
[Cloudflare's CORS proxy example](https://developers.cloudflare.com/workers/examples/cors-header-proxy/).
