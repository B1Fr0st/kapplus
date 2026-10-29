# KAP+

KAP+ is a compiler, runtime library, and development tool for Khan Academy
ProcessingJS projects. Split game logic into JavaScript modules, import assets,
and preview the compiled program in Khan's actual sandbox.

[Documentation](https://kapplus-docs.aquaboot22.chatgpt.site) ·
[Source](https://github.com/B1Fr0st/kapplus) ·
[CI](https://github.com/B1Fr0st/kapplus/actions/workflows/ci.yml)

## Install

Node.js 20 or newer is required. Install the CI-tested standalone release in an
empty project directory:

```sh
mkdir my-game
cd my-game
npm init -y
npm install --save-dev https://github.com/B1Fr0st/kapplus/releases/download/v0.1.0/kapplus-0.1.0.tgz
npx kapplus init .
npx kapplus install-browser
npx kapplus dev
```

The release tarball contains the built SDK and its declared dependencies; it
needs no workspace checkout. Chromium is downloaded separately for the real
Khan preview. Publishing also requires Git and an authenticated GitHub CLI.

## Modules and assets

```js
// movement.js
export const player = { x: 0 };
export function update() { player.x += 1; }
```

```js
// main.js
import { player, update } from "./movement.js";
import sprite from "./player.png";

export function draw() {
    update();
    background(20);
    image(sprite.image(), player.x, 100);
}
```

Named and default imports, re-exports, JSON, shared module state, and
browser-compatible npm packages are bundled into the sketch. Assets resolve
relative to their importing module and are deduplicated. Supported assets are
OBJ, GLB, PNG, and MP3. Classic global assignments such as
`draw = function() {}` remain supported; entries can also export named
ProcessingJS callbacks.

## Develop

```sh
npx kapplus dev
npx kapplus check
npx kapplus build
```

The dev command watches source modules, assets, and the manifest. Successful
edits rebuild and restart a real Khan Academy sandbox using only a compact
bootstrap and verified chunks. Errors are shown in the terminal and development
page while the last successful preview remains available. No Khan program is
saved. The development page identifies the actual Khan runtime version.

The default is the real Khan preview. `--preview local` explicitly selects a
local ProcessingJS compatibility preview, which can differ from Khan.
`--headless` runs the Khan preview without a visible Chromium window;
`--port 4174` changes the local development page's port.

## Runtime library

KAP+ injects `KAPPlus` into each compiled sketch:

- `createWebGLRenderer(options)`: native WebGL 2 rendering and thumbnails.
- `createNetwork(options)`: direct or proxied HTTP requests with cancellation.
- `createPeer(options)`: WebRTC data channels and offer/answer exchange.
- `whenReady(callback)`: wait for imported source textures to finish decoding.
- `promptCode(label, value, callback)`: an in-frame code entry/copy panel.

Imported textures provide `image()` and sampling methods; imported audio
provides `play()` and `stop()`. Refer to the documentation for options and
lifecycles. Native capabilities remain subject to Khan's current browser
policies. A networking proxy needs to allow your target API.

## Publish

Add a public chunk repository to `kapplus.json`:

```json
"publish": {
  "repository": "YOUR_USER/my-game-assets",
  "branch": "main",
  "chunks": "auto"
}
```

```sh
gh auth login
npx kapplus publish > khan-loader.js
```

Paste the loader into a new Khan JavaScript / ProcessingJS program once. Later
publishes update the CDN bootstrap; immutable release tags pin the chunks and
SHA-256 checks verify the served bytes. Only `publish --khan` additionally
opens Khan login and creates a new saved program. Never paste a large generated
program into Khan's editor; use the compact loader.

## Node API

```js
import { compileProject, startDevServer } from "kapplus";

const output = await compileProject("./kapplus.json");
const dev = await startDevServer({ project: "./kapplus.json", port: 4173 });
await dev.ready;
// await dev.close() when finished.
```

The package root exports the compiler, initialization, chunk publishing, and
development APIs. Browser automation is available separately through
`kapplus/browser-session` and `kapplus/browser-types`.

## Contributing

```sh
npm ci
npm run check
npm run build
npm test
npm run test:install
npm run test:khan
```

The final command needs Chromium and internet access. It verifies watched
module edits and error recovery in the real Khan sandbox, then compares every
canvas pixel against an independent publication run. CI tests clean installs on
Linux, macOS, and Windows, with Node 20, 22, and 24 covered on Linux.

Application projects and their media are maintained separately. This repository
contains only the reusable SDK, generated test fixtures, documentation, and CI.
