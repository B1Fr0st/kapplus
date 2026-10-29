// Kept ES5-compatible because the local preview passes through ProcessingJS.
export const networkRuntime = String.raw`
    var buildNetworkRegistry = function() {
        var clients = [];
        return ({
            add: function(client) { clients.push(client); },
            remove: function(client) {
                var index = clients.indexOf(client);
                if (index >= 0) { clients.splice(index, 1); }
            },
            closeAll: function() {
                while (clients.length) { clients[clients.length - 1].close(); }
            }
        });
    };
    var buildNetworkClient = function(nativeWindow, nativeDocument, needsFrame, options, registry) {
        options = options || {};
        var key = function(first, second) { return first + second; };
        var ReflectType = nativeWindow[key("Re", "flect")];
        var construct = function(Type, args) {
            return ReflectType[key("con", "struct")](Type, args);
        };
        var PromiseType = nativeWindow[key("Prom", "ise")];
        var URLType = nativeWindow[key("U", "RL")];
        var error = function(code, message, name) {
            var result = construct(nativeWindow[key("Er", "ror")], [message]);
            result.code = code;
            if (name) { result.name = name; }
            return result;
        };
        var positiveTimeout = function(value) {
            if (typeof value !== "number" || !(value > 0) || value === Infinity) {
                throw error("NETWORK_INVALID_REQUEST", "timeoutMs must be a finite positive number");
            }
            return value;
        };
        var parseUrl = function(value) {
            if (typeof value !== "string") {
                throw error("NETWORK_INVALID_REQUEST", "Expected an absolute HTTPS URL");
            }
            var url;
            try { url = construct(URLType, [value]); }
            catch (urlError) { throw error("NETWORK_INVALID_REQUEST", "Expected an absolute HTTPS URL"); }
            if (url.protocol !== "https:" || url.username || url.password || url.hash) {
                throw error("NETWORK_INVALID_REQUEST", "Expected an HTTPS URL without credentials or a fragment");
            }
            return url;
        };
        var timeoutMs = positiveTimeout(options.timeoutMs === undefined ? 15000 : options.timeoutMs);
        var proxyUrl = options.proxyUrl === undefined ? null : parseUrl(options.proxyUrl).href;
        if (options.proxyToken !== undefined && (!proxyUrl || typeof options.proxyToken !== "string")) {
            throw error("NETWORK_INVALID_REQUEST", "proxyToken requires proxyUrl and must be a string");
        }
        var proxyToken = options.proxyToken;
        var closed = false;
        var contextPromise = null;
        var frame = null;
        var frameTimer = null;
        var rejectFrame = null;
        var requests = [];
        var sockets = [];
        var finishSocket = function(entry) {
            if (entry.done) { return; }
            entry.done = true;
            if (entry.timer !== null) { nativeWindow.clearTimeout(entry.timer); entry.timer = null; }
            if (entry.signal) { entry.signal.removeEventListener("abort", entry.onAbort); }
            if (entry.socket) {
                entry.socket.removeEventListener("open", entry.onOpen);
                entry.socket.removeEventListener("error", entry.onError);
                entry.socket.removeEventListener("close", entry.onClose);
            }
            var index = sockets.indexOf(entry);
            if (index >= 0) { sockets.splice(index, 1); }
        };
        var removeFrame = function() {
            if (frameTimer !== null) { nativeWindow.clearTimeout(frameTimer); frameTimer = null; }
            if (frame) {
                frame.onload = null;
                frame.onerror = null;
                if (frame.parentNode) { frame.parentNode[key("remove", "Child")](frame); }
                frame = null;
            }
        };
        var context = function() {
            if (contextPromise) { return contextPromise; }
            contextPromise = construct(PromiseType, [function(resolve, reject) {
                if (!needsFrame) { resolve(nativeWindow); return; }
                rejectFrame = reject;
                var unavailable = function() {
                    removeFrame();
                    rejectFrame = null;
                    reject(error("NETWORK_UNAVAILABLE", "Could not initialize the Khan network frame"));
                };
                try {
                    frame = nativeDocument[key("create", "Element")]("iframe");
                    frame.style.display = "none";
                    frame.setAttribute("aria-hidden", "true");
                    frame.setAttribute("data-kapplus-network", "true");
                    frame.onload = function() {
                        try {
                            var networkWindow = frame[key("content", "Window")];
                            if (networkWindow.location.origin !== nativeWindow.location.origin ||
                                typeof networkWindow[key("fe", "tch")] !== "function") {
                                unavailable();
                                return;
                            }
                            nativeWindow.clearTimeout(frameTimer);
                            frameTimer = null;
                            frame.onload = null;
                            frame.onerror = null;
                            rejectFrame = null;
                            resolve(networkWindow);
                        } catch (frameError) { unavailable(); }
                    };
                    frame.onerror = unavailable;
                    frame[key("s", "rc")] = nativeWindow.location.origin + "/programming-images/space/planet.png";
                    frameTimer = nativeWindow.setTimeout(unavailable, timeoutMs);
                    nativeDocument.body[key("append", "Child")](frame);
                } catch (frameError) { unavailable(); }
            }]);
            return contextPromise;
        };
        var finish = function(entry) {
            if (entry.done) { return; }
            entry.done = true;
            if (entry.timer !== null) { nativeWindow.clearTimeout(entry.timer); entry.timer = null; }
            if (entry.signal) { entry.signal.removeEventListener("abort", entry.onAbort); }
            var index = requests.indexOf(entry);
            if (index >= 0) { requests.splice(index, 1); }
        };
        var discard = function(response) {
            if (response.body) { response.body.cancel()["catch"](function() {}); }
        };
        var keepBodyAbortable = function(response, entry) {
            if (!response.body) { finish(entry); return response; }
            var reader = response.body.getReader();
            var stream = construct(nativeWindow[key("Readable", "Stream")], [{
                pull: function(controller) {
                    return reader.read()["then"](function(part) {
                        if (part.done) { finish(entry); controller.close(); }
                        else { controller.enqueue(part.value); }
                    }, function(bodyError) { finish(entry); controller.error(bodyError); });
                },
                cancel: function(reason) {
                    entry.controller.abort(reason);
                    finish(entry);
                    return reader.cancel(reason);
                }
            }]);
            var result = construct(nativeWindow[key("Res", "ponse")], [stream, {
                status: response.status, statusText: response.statusText, headers: response.headers
            }]);
            var ObjectType = nativeWindow[key("Ob", "ject")];
            ObjectType[key("define", "Properties")](result, {
                url: { value: response.url },
                redirected: { value: response.redirected },
                type: { value: response.type }
            });
            return result;
        };
        var api = {
            openWebSocket: function(value, init) {
                return construct(PromiseType, [function(resolve, reject) {
                    if (closed) { reject(error("NETWORK_CLOSED", "Network client is closed")); return; }
                    init = init || {};
                    var entry = null;
                    try {
                        if (init.headers !== undefined) {
                            throw error("NETWORK_INVALID_REQUEST", "Browser WebSockets do not support custom request headers");
                        }
                        var target;
                        try { target = construct(URLType, [value]); }
                        catch (urlError) { throw error("NETWORK_INVALID_REQUEST", "Expected an absolute WSS URL"); }
                        if (typeof value !== "string" || target.protocol !== "wss:" || target.username || target.password || target.hash) {
                            throw error("NETWORK_INVALID_REQUEST", "Expected a WSS URL without credentials or a fragment");
                        }
                        var protocols = init.protocols;
                        if (protocols !== undefined) {
                            if (typeof protocols === "string") { protocols = [protocols]; }
                            else if (nativeWindow[key("Ob", "ject")].prototype.toString.call(protocols) === "[object Array]") { protocols = protocols.slice(0); }
                            else { throw error("NETWORK_INVALID_REQUEST", "protocols must be a string or an array of strings"); }
                            for (var index = 0; index < protocols.length; index++) {
                                if (typeof protocols[index] !== "string" || !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(protocols[index]) || protocols.indexOf(protocols[index]) !== index) {
                                    throw error("NETWORK_INVALID_REQUEST", "Invalid or duplicate WebSocket subprotocol");
                                }
                            }
                        }
                        if (init.binaryType !== undefined && init.binaryType !== "blob" && init.binaryType !== "arraybuffer") {
                            throw error("NETWORK_INVALID_REQUEST", "binaryType must be blob or arraybuffer");
                        }
                        var openTimeout = positiveTimeout(init.timeoutMs === undefined ? timeoutMs : init.timeoutMs);
                        var signal = init.signal;
                        if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
                            throw error("NETWORK_INVALID_REQUEST", "signal must be an AbortSignal");
                        }
                        entry = { socket: null, timer: null, signal: signal, done: false, opened: false };
                        entry.stop = function(reason) {
                            if (entry.done) { return; }
                            finishSocket(entry);
                            if (entry.socket && entry.socket.readyState < 2) {
                                try { entry.socket.close(1000, "KAPPlus connection closed"); } catch (closeError) {}
                            }
                            if (!entry.opened) { reject(reason); }
                        };
                        entry.onAbort = function() { entry.stop(error("NETWORK_ABORTED", "WebSocket aborted", "AbortError")); };
                        entry.onOpen = function() {
                            if (entry.done) { return; }
                            entry.opened = true;
                            nativeWindow.clearTimeout(entry.timer);
                            entry.timer = null;
                            resolve(entry.socket);
                        };
                        entry.onError = function() {
                            if (!entry.opened) { entry.stop(error("WEBSOCKET_CONNECTION_FAILED", "WebSocket connection failed")); }
                        };
                        entry.onClose = function(event) {
                            if (entry.opened) { finishSocket(entry); }
                            else {
                                var failure = error("WEBSOCKET_CONNECTION_FAILED", "WebSocket closed before opening");
                                failure.closeCode = event.code;
                                failure.closeReason = event.reason;
                                entry.stop(failure);
                            }
                        };
                        sockets.push(entry);
                        if (signal) {
                            if (signal.aborted) { entry.onAbort(); return; }
                            signal.addEventListener("abort", entry.onAbort);
                        }
                        entry.timer = nativeWindow.setTimeout(function() {
                            entry.stop(error("NETWORK_TIMEOUT", "WebSocket connection timed out"));
                        }, openTimeout);
                        context()["then"](function(networkWindow) {
                            if (entry.done) { return; }
                            var SocketType = networkWindow[key("Web", "Socket")];
                            if (typeof SocketType !== "function") { throw error("NETWORK_UNAVAILABLE", "WebSockets are unavailable in the network context"); }
                            var args = [target.href];
                            if (protocols !== undefined) { args.push(protocols); }
                            entry.socket = construct(SocketType, args);
                            if (init.binaryType !== undefined) { entry.socket.binaryType = init.binaryType; }
                            entry.socket.addEventListener("open", entry.onOpen);
                            entry.socket.addEventListener("error", entry.onError);
                            entry.socket.addEventListener("close", entry.onClose);
                        })["catch"](entry.stop);
                    } catch (socketError) {
                        if (entry) { entry.stop(socketError); }
                        else { reject(socketError); }
                    }
                }]);
            },
            fetch: function(value, init) {
                return construct(PromiseType, [function(resolve, reject) {
                    if (closed) { reject(error("NETWORK_CLOSED", "Network client is closed")); return; }
                    init = init || {};
                    var entry = null;
                    try {
                        var target = parseUrl(value);
                        var method = init.method === undefined ? "GET" : String(init.method).toUpperCase();
                        if (["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].indexOf(method) < 0) {
                            throw error("NETWORK_INVALID_REQUEST", "Unsupported HTTP method");
                        }
                        if ((method === "GET" || method === "HEAD") && init.body !== undefined && init.body !== null) {
                            throw error("NETWORK_INVALID_REQUEST", "GET and HEAD cannot have a body");
                        }
                        if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
                            var bodyType = nativeWindow[key("Ob", "ject")].prototype.toString.call(init.body);
                            var ArrayBufferType = nativeWindow[key("Array", "Buffer")];
                            if (bodyType !== "[object Blob]" && bodyType !== "[object ArrayBuffer]" &&
                                !ArrayBufferType.isView(init.body)) {
                                throw error("NETWORK_INVALID_REQUEST", "Serialize objects explicitly; unsupported request body");
                            }
                        }
                        var requestTimeout = positiveTimeout(init.timeoutMs === undefined ? timeoutMs : init.timeoutMs);
                        var headers = construct(nativeWindow[key("Head", "ers")], [init.headers || {}]);
                        var requestUrl = target.href;
                        if (proxyUrl) {
                            var endpoint = construct(URLType, [proxyUrl]);
                            endpoint.searchParams.set("url", requestUrl);
                            requestUrl = endpoint.href;
                            if (proxyToken) { headers.set("X-KAPPlus-Token", proxyToken); }
                        }
                        var signal = init.signal;
                        if (signal && (typeof signal.addEventListener !== "function" ||
                            typeof signal.removeEventListener !== "function")) {
                            throw error("NETWORK_INVALID_REQUEST", "signal must be an AbortSignal");
                        }
                        var controller = construct(nativeWindow[key("Abort", "Controller")], []);
                        entry = { controller: controller, timer: null, signal: signal, done: false };
                        entry.fail = function(reason) {
                            if (entry.done) { return; }
                            finish(entry);
                            controller.abort(reason);
                            reject(reason);
                        };
                        entry.onAbort = function() {
                            entry.fail(error("NETWORK_ABORTED", "Request aborted", "AbortError"));
                        };
                        requests.push(entry);
                        if (signal) {
                            if (signal.aborted) { entry.onAbort(); return; }
                            signal.addEventListener("abort", entry.onAbort);
                        }
                        entry.timer = nativeWindow.setTimeout(function() {
                            entry.fail(error("NETWORK_TIMEOUT", "Network request timed out"));
                        }, requestTimeout);
                        var requestOptions = {
                            method: method, headers: headers, body: init.body,
                            credentials: "omit", redirect: "manual", signal: controller.signal
                        };
                        if (init.cache !== undefined) { requestOptions.cache = init.cache; }
                        context()["then"](function(networkWindow) {
                            if (entry.done) { return; }
                            return networkWindow[key("fe", "tch")](requestUrl, requestOptions)["then"](function(response) {
                                if (entry.done) {
                                    discard(response);
                                    return;
                                }
                                nativeWindow.clearTimeout(entry.timer);
                                entry.timer = null;
                                var proxyCode = proxyUrl && response.headers.get("X-KAPPlus-Error");
                                if (proxyCode) {
                                    var proxyError = error("PROXY_ERROR", "Network proxy: " + proxyCode);
                                    proxyError.status = response.status;
                                    proxyError.proxyCode = proxyCode;
                                    entry.fail(proxyError);
                                    discard(response);
                                    return;
                                }
                                resolve(keepBodyAbortable(response, entry));
                            });
                        })["catch"](entry.fail);
                    } catch (requestError) {
                        if (entry) { entry.fail(requestError); }
                        else { reject(requestError); }
                    }
                }]);
            },
            close: function() {
                if (closed) { return; }
                closed = true;
                var reason = error("NETWORK_ABORTED", "Network client closed", "AbortError");
                while (requests.length) { requests[requests.length - 1].fail(reason); }
                while (sockets.length) { sockets[sockets.length - 1].stop(reason); }
                if (rejectFrame) { rejectFrame(reason); rejectFrame = null; }
                removeFrame();
                registry.remove(api);
            }
        };
        registry.add(api);
        return api;
    };
`;
