import type { KapPlusTarget } from "./types.js";
import { networkRuntime } from "./network.js";

const sharedRuntime = String.raw`
var KAPPlus = (function() {
    var makeTextureImage;
    var makeWebGLRenderer;
    var makeWebRTCPeer;
    var makeNetwork;
    var promptForCode;
    var buildCodePanel;
    var decodeBase64;
    var loadTextureSource;
    var runtimeGlobal = null;
    var pendingTextures = 0;
    var totalSourceTextures = 0;
    var completedSourceTextures = 0;
    var textureLoadActive = false;
    var textureLoadQueue = [];
    var readyCallbacks = [];
    var finishTexture = function() {
        pendingTextures--;
        completedSourceTextures++;
        if (runtimeGlobal) {
            runtimeGlobal.__kapplusPendingTextures = pendingTextures;
            runtimeGlobal.__kapplusAssetStatus = pendingTextures === 0 ? {
                phase: "ready",
                name: "",
                current: totalSourceTextures,
                total: totalSourceTextures
            } : runtimeGlobal.__kapplusAssetStatus;
        }
        textureLoadActive = false;
        if (pendingTextures === 0) {
            while (readyCallbacks.length > 0) {
                readyCallbacks.shift()();
            }
        }
        pumpTextureQueue();
    };
    var pumpTextureQueue = function() {
        if (textureLoadActive || textureLoadQueue.length === 0) {
            return;
        }
        textureLoadActive = true;
        var request = textureLoadQueue.shift();
        if (runtimeGlobal) {
            runtimeGlobal.__kapplusAssetStatus = {
                phase: "decompiling",
                name: request.data.name || "texture",
                current: completedSourceTextures + 1,
                total: totalSourceTextures
            };
        }
        loadTextureSource(request.data, function(rgbaBytes) {
            request.data.rgbaBytes = rgbaBytes;
            finishTexture();
        });
    };
    var queueTextureSource = function(data) {
        pendingTextures++;
        totalSourceTextures++;
        if (runtimeGlobal) {
            runtimeGlobal.__kapplusPendingTextures = pendingTextures;
            if (runtimeGlobal.__kapplusAssetStatus) {
                runtimeGlobal.__kapplusAssetStatus.total = totalSourceTextures;
            }
        }
        textureLoadQueue.push({ data: data });
        pumpTextureQueue();
    };
    var whenReady = function(callback) {
        if (pendingTextures === 0) {
            callback();
        } else {
            readyCallbacks.push(callback);
        }
    };
    var base85Alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
    var base85Lookup = {};
    for (var alphabetIndex = 0; alphabetIndex < base85Alphabet.length; alphabetIndex++) {
        base85Lookup[base85Alphabet.charAt(alphabetIndex)] = alphabetIndex;
    }
    var decodeBase85Into = function(data, output, byteLength) {
        var outputIndex = 0;
        for (var offset = 0; offset < data.length && outputIndex < byteLength; offset += 5) {
            var value = 0;
            for (var digit = 0; digit < 5; digit++) {
                value = value * 85 + base85Lookup[data.charAt(offset + digit)];
            }
            var divisor = 16777216;
            for (var byteIndex = 0; byteIndex < 4 && outputIndex < byteLength; byteIndex++) {
                output[outputIndex++] = floor(value / divisor) % 256;
                divisor /= 256;
            }
        }
        return output;
    };
    var decodeFloat32 = function(data, count) {
        var bytes = decodeBase64(data);
        var result = [];
        for (var index = 0; index < count; index++) {
            var offset = index * 4;
            var bits = (
                bytes.charCodeAt(offset) |
                (bytes.charCodeAt(offset + 1) << 8) |
                (bytes.charCodeAt(offset + 2) << 16) |
                (bytes.charCodeAt(offset + 3) << 24)
            ) >>> 0;
            var sign = bits >>> 31 ? -1 : 1;
            var exponent = (bits >>> 23) & 255;
            var mantissa = bits & 8388607;
            if (exponent === 255) {
                result.push(mantissa ? NaN : sign * Infinity);
            } else if (exponent === 0) {
                result.push(sign * mantissa * Math.pow(2, -149));
            } else {
                result.push(sign * (1 + mantissa / 8388608) * Math.pow(2, exponent - 127));
            }
        }
        return result;
    };
    var decodeNormal8 = function(data, count) {
        var bytes = decodeBase64(data);
        var result = [];
        for (var index = 0; index < count; index++) {
            var value = bytes.charCodeAt(index);
            result.push((value > 127 ? value - 256 : value) / 127);
        }
        return result;
    };
    var decodeUnsigned = function(data, count, byteWidth) {
        var bytes = decodeBase64(data);
        var result = [];
        for (var index = 0; index < count; index++) {
            var offset = index * byteWidth;
            var value = bytes.charCodeAt(offset) | (bytes.charCodeAt(offset + 1) << 8);
            if (byteWidth === 4) {
                value = (value | (bytes.charCodeAt(offset + 2) << 16) |
                    (bytes.charCodeAt(offset + 3) << 24)) >>> 0;
            }
            result.push(value);
        }
        return result;
    };
    var decodeTexturePixels = function(data, encoding, count) {
        var bytes = decodeBase64(data);
        var result = [];
        var offset = 0;
        var byteWidth = encoding.indexOf("32") >= 0 ? 4 : 2;
        var readPixel = function() {
            var value = bytes.charCodeAt(offset) + bytes.charCodeAt(offset + 1) * 256;
            if (byteWidth === 4) {
                value += bytes.charCodeAt(offset + 2) * 65536 +
                    bytes.charCodeAt(offset + 3) * 16777216;
            }
            offset += byteWidth;
            return value;
        };
        if (encoding === "u16" || encoding === "u32") {
            for (var index = 0; index < count; index++) {
                result.push(readPixel());
            }
            return result;
        }
        while (result.length < count) {
            var control = bytes.charCodeAt(offset++);
            if (control < 128) {
                var literalCount = control + 1;
                for (var literal = 0; literal < literalCount; literal++) {
                    result.push(readPixel());
                }
            } else {
                var runCount = control - 127;
                var pixel = readPixel();
                for (var run = 0; run < runCount; run++) {
                    result.push(pixel);
                }
            }
        }
        return result;
    };
    var decodePixel = function(value, format) {
        if (format === "rgba8888") {
            return [
                floor(value / 16777216) % 256,
                floor(value / 65536) % 256,
                floor(value / 256) % 256,
                value % 256
            ];
        }
        var alpha = value & 32768 ? 255 : 0;
        var red = ((value >> 10) & 31) * 255 / 31;
        var green = ((value >> 5) & 31) * 255 / 31;
        var blue = (value & 31) * 255 / 31;
        return [round(red), round(green), round(blue), alpha];
    };
    var mesh = function(data) {
        data.vertices = decodeFloat32(data.vertexData, data.vertexValueCount);
        data.normals = decodeNormal8(data.normalData, data.normalValueCount);
        if (data.uvEncoding === "zero") {
            data.uvs = [];
            for (var index = 0; index < data.uvValueCount; index++) {
                data.uvs.push(0);
            }
        } else {
            data.uvs = decodeFloat32(data.uvData, data.uvValueCount);
        }
        if (data.indexEncoding === "sequence") {
            data.indices = [];
            for (var index = 0; index < data.indexCount; index++) {
                data.indices.push(index);
            }
        } else {
            data.indices = decodeUnsigned(
                data.indexData,
                data.indexCount,
                data.indexEncoding === "u16" ? 2 : 4
            );
        }
        if (data.materialEncoding === "sequence") {
            data.triangleMaterials = [];
            for (var index = 0; index < data.materialCount; index++) {
                data.triangleMaterials.push(index);
            }
        } else {
            data.triangleMaterials = decodeUnsigned(
                data.materialData,
                data.materialCount,
                data.materialEncoding === "u16" ? 2 : 4
            );
        }
        data.vertexCount = data.vertices.length / 3;
        data.triangleCount = data.indices.length / 3;
        return data;
    };
    var texture = function(data) {
        var cachedImage = null;
        data.rgbaBytes = null;
        data.packedPixels = data.sourceEncoding === "png"
            ? []
            : decodeTexturePixels(data.pixelData, data.pixelEncoding, data.pixelCount);
        if (data.sourceEncoding === "png") {
            queueTextureSource(data);
        }
        var pixelAt = function(x, y) {
            x = (x % data.width + data.width) % data.width;
            y = (y % data.height + data.height) % data.height;
            if (data.rgbaBytes) {
                var offset = (y * data.width + x) * 4;
                return [
                    data.rgbaBytes[offset],
                    data.rgbaBytes[offset + 1],
                    data.rgbaBytes[offset + 2],
                    data.rgbaBytes[offset + 3]
                ];
            }
            return decodePixel(data.packedPixels[y * data.width + x], data.pixelFormat);
        };
        data.sampleNearest = function(u, v) {
            var x = floor(((u % 1 + 1) % 1) * data.width);
            var y = floor(((v % 1 + 1) % 1) * data.height);
            return pixelAt(x, y);
        };
        data.sampleLinear = function(u, v) {
            var x = ((u % 1 + 1) % 1) * data.width - 0.5;
            var y = ((v % 1 + 1) % 1) * data.height - 0.5;
            var x0 = floor(x);
            var y0 = floor(y);
            var xBlend = x - x0;
            var yBlend = y - y0;
            var topLeft = pixelAt(x0, y0);
            var topRight = pixelAt(x0 + 1, y0);
            var bottomLeft = pixelAt(x0, y0 + 1);
            var bottomRight = pixelAt(x0 + 1, y0 + 1);
            var result = [];
            for (var channel = 0; channel < 4; channel++) {
                var top = topLeft[channel] * (1 - xBlend) + topRight[channel] * xBlend;
                var bottom = bottomLeft[channel] * (1 - xBlend) + bottomRight[channel] * xBlend;
                result.push(round(top * (1 - yBlend) + bottom * yBlend));
            }
            return result;
        };
        data.sample = data.filter === "linear" ? data.sampleLinear : data.sampleNearest;
        data.image = function() {
            if (cachedImage) {
                return cachedImage;
            }
            cachedImage = makeTextureImage(data, decodePixel);
            return cachedImage;
        };
        return data;
    };
    var imageFromPixels = function(width, height, packedValues) {
        return makeTextureImage({
            width: width,
            height: height,
            packedPixels: packedValues,
            pixelFormat: "rgba8888"
        }, decodePixel);
    };
    var buildWebGLRenderer = function(nativeWindow, nativeDocument, options) {
        options = options || {};
        var meshData = options.mesh;
        if (!meshData) {
            throw new Error("KAP+ WebGL renderer requires a mesh");
        }
        var displayWidth = options.width || 600;
        var displayHeight = options.height || 600;
        var pixelRatio = options.pixelRatio || Math.min(nativeWindow.devicePixelRatio || 1, 2);
        var sourceCanvas = nativeDocument.getElementById("kapplus-processing-canvas") ||
            nativeDocument.getElementById("output-canvas") ||
            nativeDocument.getElementById("kapplus-canvas");
        var previousCanvas = nativeDocument.querySelector("[data-kapplus-webgl]");
        if (previousCanvas && previousCanvas.parentNode) {
            if (previousCanvas.__kapplusDispose) {
                previousCanvas.__kapplusDispose();
            }
            previousCanvas.parentNode.removeChild(previousCanvas);
        }
        var canvas = nativeDocument.createElement("canvas");
        var sourceCanvasId = sourceCanvas
            ? sourceCanvas.getAttribute("data-kapplus-source-id") || sourceCanvas.id
            : "output-canvas";
        canvas.id = sourceCanvasId;
        canvas.setAttribute("data-kapplus-webgl", "true");
        canvas.width = Math.round(displayWidth * pixelRatio);
        canvas.height = Math.round(displayHeight * pixelRatio);
        canvas.style.width = displayWidth + "px";
        canvas.style.height = displayHeight + "px";
        canvas.style.display = "block";
        if (sourceCanvas && sourceCanvas.parentNode) {
            sourceCanvas.setAttribute("data-kapplus-source-id", sourceCanvasId);
            sourceCanvas.id = "kapplus-processing-canvas";
            sourceCanvas.parentNode.insertBefore(canvas, sourceCanvas);
            sourceCanvas.style.display = "none";
        } else {
            nativeDocument.body.appendChild(canvas);
        }
        var gl = canvas.getContext("webgl2", {
            alpha: false,
            antialias: true,
            depth: true,
            powerPreference: "high-performance",
            preserveDrawingBuffer: true
        });
        if (!gl) {
            throw new Error("KAP+ WebGL 2 is unavailable");
        }
        var vertexShaderSource =
            "#version 300 es\n" +
            "precision highp float;\n" +
            "layout(location=0) in vec3 aPosition;\n" +
            "layout(location=1) in vec3 aNormal;\n" +
            "layout(location=2) in vec2 aUv;\n" +

            "uniform vec3 uCenter;\n" +
            "uniform float uScale;\n" +

            // Base/model orientation
            "uniform float uYaw;\n" +
            "uniform float uPitch;\n" +
            "uniform float uRoll;\n" +

            // Individual instance offset in clip space
            "uniform vec3 uPosition;\n" +
            "uniform vec3 uSize;\n" +
            "uniform vec2 uUvScale;\n" +
            "uniform float uPerspective;\n" +
            "uniform vec3 uCameraPosition;\n" +
            "uniform float uCameraYaw;\n" +
            "uniform float uCameraPitch;\n" +
            "uniform float uAspect;\n" +
            "uniform float uFocal;\n" +

            "out vec3 vNormal;\n" +
            "out vec3 vPosition;\n" +
            "out vec2 vUv;\n" +

            "void main(){\n" +
            " float cy=cos(uYaw), sy=sin(uYaw);\n" +
            " float cp=cos(uPitch), sp=sin(uPitch);\n" +
            " float cr=cos(uRoll), sr=sin(uRoll);\n" +

            " vec3 p=aPosition-uCenter;\n" +

            // Yaw around Y
            " vec3 y=vec3(\n" +
            "   p.x*cy+p.z*sy,\n" +
            "   p.y,\n" +
            "   -p.x*sy+p.z*cy\n" +
            " );\n" +

            // Pitch around X
            " vec3 q=vec3(\n" +
            "   y.x,\n" +
            "   y.y*cp-y.z*sp,\n" +
            "   y.y*sp+y.z*cp\n" +
            " );\n" +

            // Roll around Z
            " vec3 r=vec3(\n" +
            "   q.x*cr-q.y*sr,\n" +
            "   q.x*sr+q.y*cr,\n" +
            "   q.z\n" +
            " );\n" +

            // Rotate normal the same way
            " vec3 n=vec3(\n" +
            "   aNormal.x*cy+aNormal.z*sy,\n" +
            "   aNormal.y,\n" +
            "   -aNormal.x*sy+aNormal.z*cy\n" +
            " );\n" +

            " n=vec3(\n" +
            "   n.x,\n" +
            "   n.y*cp-n.z*sp,\n" +
            "   n.y*sp+n.z*cp\n" +
            " );\n" +

            " n=vec3(\n" +
            "   n.x*cr-n.y*sr,\n" +
            "   n.x*sr+n.y*cr,\n" +
            "   n.z\n" +
            " );\n" +

            " vNormal=n;\n" +
            " vPosition=r;\n" +
            " vUv=aUv*uUvScale;\n" +

            " vec3 finalPosition=r*uScale*uSize+uPosition;\n" +
            " if(uPerspective>0.5){\n" +
            "  vec3 d=finalPosition-uCameraPosition;\n" +
            "  float c=cos(uCameraYaw),s=sin(uCameraYaw);\n" +
            "  float vx=-d.x*s+d.z*c;\n" +
            "  float vz=d.x*c+d.z*s;\n" +
            "  float ccp=cos(uCameraPitch),csp=sin(uCameraPitch);\n" +
            "  float vy=d.y*ccp+vz*csp;\n" +
            "  float depth=vz*ccp-d.y*csp;\n" +
            "  gl_Position=vec4(vx*uFocal/uAspect,vy*uFocal,depth*1.001-0.201,depth);\n" +
            " }else{gl_Position=vec4(finalPosition.x,finalPosition.y,-finalPosition.z,1.0);}\n" +
            "}";
        var fragmentShaderSource =
            "#version 300 es\n" +
            "precision highp float;\n" +
            "uniform sampler2D uTexture;\n" +
            "uniform sampler2D uRoughnessMap;\n" +
            "uniform sampler2D uMetallicMap;\n" +
            "uniform sampler2D uNormalMap;\n" +
            "uniform float uUnlit;\n" +
            "uniform float uRoughness;\n" +
            "uniform float uMetallic;\n" +
            "uniform float uHasNormalMap;\n" +
            "in vec3 vNormal;\n" +
            "in vec3 vPosition;\n" +
            "in vec2 vUv;\n" +
            "out vec4 outColor;\n" +
            "vec3 toneMap(vec3 x){return clamp(x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14),0.0,1.0);}\n" +
            "void main(){\n" +
            " vec4 texel=texture(uTexture,vUv);\n" +
            " if(texel.a<0.094){discard;}\n" +
            " if(uUnlit>0.5){outColor=texel;return;}\n" +
            " vec3 n=normalize(vNormal);\n" +
            " if(!gl_FrontFacing){n=-n;}\n" +
            " if(uHasNormalMap>0.5){\n" +
            "  vec3 dpdx=dFdx(vPosition),dpdy=dFdy(vPosition);\n" +
            "  vec2 duvdx=dFdx(vUv),duvdy=dFdy(vUv);\n" +
            "  float determinant=duvdx.x*duvdy.y-duvdx.y*duvdy.x;\n" +
            "  if(abs(determinant)>0.000001){\n" +
            "   vec3 tangent=normalize((dpdx*duvdy.y-dpdy*duvdx.y)/determinant);\n" +
            "   tangent=normalize(tangent-n*dot(n,tangent));\n" +
            "   vec3 bitangent=cross(n,tangent)*sign(determinant);\n" +
            "   vec3 mapped=texture(uNormalMap,vUv).xyz*2.0-1.0;\n" +
            "   n=normalize(mat3(tangent,bitangent,n)*mapped);\n" +
            "  }\n" +
            " }\n" +
            " float roughness=clamp(uRoughness*texture(uRoughnessMap,vUv).r,0.045,1.0);\n" +
            " float metallic=clamp(uMetallic*texture(uMetallicMap,vUv).r,0.0,1.0);\n" +
            " vec3 key=normalize(vec3(-0.35,0.78,0.52));\n" +
            " vec3 fill=normalize(vec3(0.62,0.18,0.42));\n" +
            " vec3 base=pow(texel.rgb,vec3(2.2));\n" +
            " vec3 view=vec3(0.0,0.0,1.0);\n" +
            " vec3 reflected=reflect(-view,n);\n" +
            " float softness=roughness*roughness;\n" +
            " float stripA=exp(-pow((reflected.x+0.38)/(0.09+0.42*softness),2.0)-pow((reflected.y-0.62)/(0.48+0.35*softness),2.0));\n" +
            " float stripB=exp(-pow((reflected.x-0.58)/(0.12+0.38*softness),2.0)-pow((reflected.y-0.42)/(0.62+0.25*softness),2.0));\n" +
            " vec3 environment=mix(vec3(0.07,0.09,0.13),vec3(0.25,0.31,0.39),smoothstep(-0.5,0.8,reflected.y));\n" +
            " environment+=stripA*vec3(1.45,1.40,1.30)+stripB*vec3(0.75,0.85,1.00);\n" +
            " vec3 f0=mix(vec3(0.045),base,metallic);\n" +
            " vec3 fresnel=f0+(vec3(1.0)-f0)*pow(1.0-max(dot(n,view),0.0),5.0);\n" +
            " float diffuse=0.42+0.78*max(dot(n,key),0.0)+0.18*max(dot(n,fill),0.0);\n" +
            " vec3 lit=base*diffuse*(1.0-metallic)+environment*fresnel*(1.0-0.45*roughness);\n" +
            " outColor=vec4(pow(toneMap(lit),vec3(1.0/2.2)),texel.a);\n" +
            "}";
        var compileShader = function(type, source) {
            var shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error("KAP+ shader error: " + gl.getShaderInfoLog(shader));
            }
            return shader;
        };
        var program = gl.createProgram();
        gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShaderSource));
        gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error("KAP+ WebGL link error: " + gl.getProgramInfoLog(program));
        }
        gl.useProgram(program);
        var vertexArray = gl.createVertexArray();
        gl.bindVertexArray(vertexArray);
        var uploadAttribute = function(location, values, width) {
            var buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new nativeWindow.Float32Array(values), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, width, gl.FLOAT, false, 0, 0);
        };
        uploadAttribute(0, meshData.vertices, 3);
        uploadAttribute(1, meshData.normals, 3);
        uploadAttribute(2, meshData.uvs, 2);
        var textures = options.textures || [];
        var materialCount = Math.max(textures.length, 1);
        var counts = [];
        var index;
        for (index = 0; index < materialCount; index++) {
            counts[index] = 0;
        }
        for (index = 0; index < meshData.triangleMaterials.length; index++) {
            var countedMaterial = meshData.triangleMaterials[index] || 0;
            if (countedMaterial >= materialCount) {
                countedMaterial = 0;
            }
            counts[countedMaterial]++;
        }
        var starts = [];
        var cursors = [];
        var totalIndices = 0;
        for (index = 0; index < materialCount; index++) {
            starts[index] = totalIndices;
            cursors[index] = totalIndices;
            totalIndices += counts[index] * 3;
        }
        var sortedIndices = new nativeWindow.Uint32Array(totalIndices);
        for (index = 0; index < meshData.triangleMaterials.length; index++) {
            var material = meshData.triangleMaterials[index] || 0;
            if (material >= materialCount) {
                material = 0;
            }
            var destination = cursors[material];
            var source = index * 3;
            sortedIndices[destination] = meshData.indices[source];
            sortedIndices[destination + 1] = meshData.indices[source + 1];
            sortedIndices[destination + 2] = meshData.indices[source + 2];
            cursors[material] += 3;
        }
        var indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sortedIndices, gl.STATIC_DRAW);
        var maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        var anisotropy = gl.getExtension("EXT_texture_filter_anisotropic") ||
            gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
        var timerQuery = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        var pendingTimerQuery = null;
        var uploadedSources = [];
        var uploadedTextures = [];
        var textureFor = function(textureData) {
            var cachedIndex = uploadedSources.indexOf(textureData);
            if (cachedIndex >= 0) {
                return uploadedTextures[cachedIndex];
            }
            if (!textureData || textureData.width > maximumTextureSize ||
                textureData.height > maximumTextureSize) {
                throw new Error("KAP+ texture exceeds this GPU's source-quality limit");
            }
            var bytes = textureData.rgbaBytes;
            if (!bytes) {
                bytes = new nativeWindow.Uint8Array(textureData.width * textureData.height * 4);
                for (var pixel = 0; pixel < textureData.packedPixels.length; pixel++) {
                    var rgba = decodePixel(textureData.packedPixels[pixel], textureData.pixelFormat);
                    var byteOffset = pixel * 4;
                    bytes[byteOffset] = rgba[0];
                    bytes[byteOffset + 1] = rgba[1];
                    bytes[byteOffset + 2] = rgba[2];
                    bytes[byteOffset + 3] = rgba[3];
                }
            }
            var gpuTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, gpuTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, textureData.width, textureData.height,
                0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
            if (anisotropy) {
                var maximumAnisotropy = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
                gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
                    Math.min(maximumAnisotropy, options.anisotropy || 8));
            }
            uploadedSources.push(textureData);
            uploadedTextures.push(gpuTexture);
            if (options.releaseTexturePixels) {
                textureData.rgbaBytes = null;
                textureData.packedPixels = [];
            }
            return gpuTexture;
        };
        var gpuTextures = [];
        for (index = 0; index < materialCount; index++) {
            gpuTextures[index] = textureFor(textures[index] || textures[0]);
        }
        var solidTexture = function(red, green, blue) {
            var result = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, result);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, new nativeWindow.Uint8Array([red, green, blue, 255]));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            return result;
        };
        var whiteTexture = solidTexture(255, 255, 255);
        var neutralNormalTexture = solidTexture(128, 128, 255);
        var gpuRoughnessMaps = [];
        var gpuMetallicMaps = [];
        var gpuNormalMaps = [];
        for (index = 0; index < materialCount; index++) {
            gpuRoughnessMaps[index] = options.roughnessMaps && options.roughnessMaps[index]
                ? textureFor(options.roughnessMaps[index]) : whiteTexture;
            gpuMetallicMaps[index] = options.metallicMaps && options.metallicMaps[index]
                ? textureFor(options.metallicMaps[index]) : whiteTexture;
            gpuNormalMaps[index] = options.normalMaps && options.normalMaps[index]
                ? textureFor(options.normalMaps[index]) : neutralNormalTexture;
        }
        var minimum = [Infinity, Infinity, Infinity];
        var maximum = [-Infinity, -Infinity, -Infinity];
        for (index = 0; index < meshData.vertices.length; index += 3) {
            for (var axis = 0; axis < 3; axis++) {
                minimum[axis] = Math.min(minimum[axis], meshData.vertices[index + axis]);
                maximum[axis] = Math.max(maximum[axis], meshData.vertices[index + axis]);
            }
        }
        var center = [
            (minimum[0] + maximum[0]) * 0.5,
            (minimum[1] + maximum[1]) * 0.5,
            (minimum[2] + maximum[2]) * 0.5
        ];
        var radius = 0;
        for (index = 0; index < meshData.vertices.length; index += 3) {
            var dx = meshData.vertices[index] - center[0];
            var dy = meshData.vertices[index + 1] - center[1];
            var dz = meshData.vertices[index + 2] - center[2];
            radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        var centerLocation = gl.getUniformLocation(program, "uCenter");
        var scaleLocation = gl.getUniformLocation(program, "uScale");

        var yawLocation = gl.getUniformLocation(program, "uYaw");
        var pitchLocation = gl.getUniformLocation(program, "uPitch");

        var rollLocation = gl.getUniformLocation(program, "uRoll");
        var positionLocation = gl.getUniformLocation(program, "uPosition");
        var sizeLocation = gl.getUniformLocation(program, "uSize");
        var uvScaleLocation = gl.getUniformLocation(program, "uUvScale");
        var perspectiveLocation = gl.getUniformLocation(program, "uPerspective");
        var cameraPositionLocation = gl.getUniformLocation(program, "uCameraPosition");
        var cameraYawLocation = gl.getUniformLocation(program, "uCameraYaw");
        var cameraPitchLocation = gl.getUniformLocation(program, "uCameraPitch");
        var aspectLocation = gl.getUniformLocation(program, "uAspect");
        var focalLocation = gl.getUniformLocation(program, "uFocal");

        var roughnessLocation = gl.getUniformLocation(program, "uRoughness");
        var metallicLocation = gl.getUniformLocation(program, "uMetallic");
        var hasNormalMapLocation = gl.getUniformLocation(program, "uHasNormalMap");
        var unlitLocation = gl.getUniformLocation(program, "uUnlit");
        gl.uniform1f(unlitLocation, options.unlit ? 1 : 0);
        gl.uniform3f(centerLocation, options.perspective ? 0 : center[0],
            options.perspective ? 0 : center[1], options.perspective ? 0 : center[2]);
        gl.uniform1f(scaleLocation, options.perspective ? 1 : (options.fit || 0.96) / radius);
        gl.uniform1f(perspectiveLocation, options.perspective ? 1 : 0);
        gl.uniform1f(aspectLocation, displayWidth / displayHeight);
        gl.uniform1f(focalLocation, 1 / Math.tan((options.fov || 1.2) * 0.5));
        gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
        gl.uniform1i(gl.getUniformLocation(program, "uRoughnessMap"), 1);
        gl.uniform1i(gl.getUniformLocation(program, "uMetallicMap"), 2);
        gl.uniform1i(gl.getUniformLocation(program, "uNormalMap"), 3);
        var drawModel = function(instance) {
            instance = instance || {};
            gl.uniform1f(unlitLocation, instance.unlit === undefined
                ? (options.unlit ? 1 : 0)
                : (instance.unlit ? 1 : 0));

            var position = instance.position || [0, 0, 0];
            var yaw = instance.yaw || 0;
            var pitch = instance.pitch || 0;
            var roll = instance.roll || 0;
            var scale = instance.scale === undefined ? 1 : instance.scale;
            var size = instance.size || [1, 1, 1];
            gl.uniform3f(sizeLocation, size[0], size[1], size[2]);
            var uvScale = instance.uvScale || [1, 1];
            gl.uniform2f(uvScaleLocation, uvScale[0], uvScale[1]);

            gl.uniform3f(
                positionLocation,
                position[0] || 0,
                position[1] || 0,
                position[2] || 0
            );

            gl.uniform1f(yawLocation, yaw);
            gl.uniform1f(pitchLocation, pitch);
            gl.uniform1f(rollLocation, roll);

            // Base model fitting scale × per-instance scale.
            gl.uniform1f(
                scaleLocation,
                (options.perspective ? 1 : (options.fit || 0.96) / radius) * scale
            );

            for (var drawMaterial = 0; drawMaterial < materialCount; drawMaterial++) {
                if (instance.material !== undefined && instance.material !== drawMaterial) {
                    continue;
                }
                if (counts[drawMaterial] === 0) {
                    continue;
                }

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(
                    gl.TEXTURE_2D,
                    gpuTextures[drawMaterial]
                );
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, gpuRoughnessMaps[drawMaterial]);
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, gpuMetallicMaps[drawMaterial]);
                gl.activeTexture(gl.TEXTURE3);
                gl.bindTexture(gl.TEXTURE_2D, gpuNormalMaps[drawMaterial]);
                gl.uniform1f(hasNormalMapLocation,
                    options.normalMaps && options.normalMaps[drawMaterial] ? 1 : 0);

                gl.uniform1f(
                    roughnessLocation,
                    options.roughness &&
                    options.roughness[drawMaterial] !== undefined
                        ? options.roughness[drawMaterial]
                        : 0.6
                );

                gl.uniform1f(
                    metallicLocation,
                    options.metallic &&
                    options.metallic[drawMaterial] !== undefined
                        ? options.metallic[drawMaterial]
                        : 0
                );

                gl.drawElements(
                    gl.TRIANGLES,
                    counts[drawMaterial] * 3,
                    gl.UNSIGNED_INT,
                    starts[drawMaterial] * 4
                );
            }
        };
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        var background = options.background || [247, 244, 236];
        var stats = {
            frameCount: 0,
            lastFrameMs: 0,
            averageFrameMs: 0,
            averageFrameIntervalMs: 0,
            fps: 0,
            gpuFrameMs: null,
            triangleCount: meshData.triangleCount,
            sourceTextureCount: uploadedTextures.length,
            backingWidth: canvas.width,
            backingHeight: canvas.height
        };
        var previousFrameStarted = 0;
        var renderInstances = function(instances) {
            var started = nativeWindow.performance.now();

            if (previousFrameStarted > 0) {
                var frameInterval = started - previousFrameStarted;

                stats.averageFrameIntervalMs =
                    stats.averageFrameIntervalMs === 0
                        ? frameInterval
                        : stats.averageFrameIntervalMs * 0.9 +
                        frameInterval * 0.1;

                stats.fps = 1000 / stats.averageFrameIntervalMs;
            }

            previousFrameStarted = started;

            if (
                pendingTimerQuery &&
                gl.getQueryParameter(
                    pendingTimerQuery,
                    gl.QUERY_RESULT_AVAILABLE
                )
            ) {
                if (!gl.getParameter(timerQuery.GPU_DISJOINT_EXT)) {
                    stats.gpuFrameMs =
                        gl.getQueryParameter(
                            pendingTimerQuery,
                            gl.QUERY_RESULT
                        ) / 1000000;
                }

                gl.deleteQuery(pendingTimerQuery);
                pendingTimerQuery = null;
            }

            var activeTimerQuery = null;

            if (timerQuery && !pendingTimerQuery) {
                activeTimerQuery = gl.createQuery();

                gl.beginQuery(
                    timerQuery.TIME_ELAPSED_EXT,
                    activeTimerQuery
                );
            }

            gl.viewport(
                0,
                0,
                canvas.width,
                canvas.height
            );

            gl.clearColor(
                background[0] / 255,
                background[1] / 255,
                background[2] / 255,
                1
            );

            gl.clear(
                gl.COLOR_BUFFER_BIT |
                gl.DEPTH_BUFFER_BIT
            );

            gl.useProgram(program);
            gl.bindVertexArray(vertexArray);
            var camera = options.camera || {};
            var cameraPosition = camera.position || [0, 0, 0];
            gl.uniform3f(cameraPositionLocation, cameraPosition[0], cameraPosition[1], cameraPosition[2]);
            gl.uniform1f(cameraYawLocation, camera.yaw || 0);
            gl.uniform1f(cameraPitchLocation, camera.pitch || 0);

            for (var i = 0; i < instances.length; i++) {
                drawModel(instances[i]);
            }

            if (activeTimerQuery) {
                gl.endQuery(timerQuery.TIME_ELAPSED_EXT);
                pendingTimerQuery = activeTimerQuery;
            }

            var elapsed =
                nativeWindow.performance.now() -
                started;

            stats.frameCount++;
            stats.lastFrameMs = elapsed;

            stats.averageFrameMs +=
                (elapsed - stats.averageFrameMs) /
                stats.frameCount;

            if (runtimeGlobal) {
                runtimeGlobal.__kapplusRenderStats = stats;
            }
        };
        var render = function(yaw, pitch) {
            renderInstances([
                {
                    position: [0, 0, 0],
                    yaw: yaw || 0,
                    pitch: pitch || 0,
                    roll: 0,
                    scale: 1
                }
            ]);
        };
        var thumbnailHeld = false;
        var thumbnailContext = sourceCanvas ? sourceCanvas.getContext("2d") : null;
        var copyToThumbnailCanvas = function() {
            if (!thumbnailContext || !sourceCanvas) {
                return false;
            }
            gl.flush();
            thumbnailContext.save();
            thumbnailContext.setTransform(1, 0, 0, 1, 0, 0);
            thumbnailContext.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
            thumbnailContext.drawImage(
                canvas,
                0,
                0,
                canvas.width,
                canvas.height,
                0,
                0,
                sourceCanvas.width,
                sourceCanvas.height
            );
            thumbnailContext.restore();
            return true;
        };
        var showThumbnailCanvas = function() {
            if (!copyToThumbnailCanvas()) {
                return false;
            }
            thumbnailHeld = true;
            canvas.style.display = "none";
            sourceCanvas.style.display = "block";
            return true;
        };
        var hideThumbnailCanvas = function() {
            thumbnailHeld = false;
            if (sourceCanvas) {
                sourceCanvas.style.display = "none";
            }
            canvas.style.display = "block";
        };
        var isSpaceKey = function(event) {
            return event.code === "Space" || event.key === " " || event.keyCode === 32;
        };
        var handleThumbnailKeyDown = function(event) {
            if (!isSpaceKey(event)) {
                return;
            }
            showThumbnailCanvas();
            if (event.preventDefault) {
                event.preventDefault();
            }
        };
        var handleThumbnailKeyUp = function(event) {
            if (!isSpaceKey(event)) {
                return;
            }
            hideThumbnailCanvas();
            if (event.preventDefault) {
                event.preventDefault();
            }
        };
        var handleThumbnailBlur = function() {
            if (thumbnailHeld) {
                hideThumbnailCanvas();
            }
        };
        var thumbnailHotkey = options.thumbnailHotkey !== false && sourceCanvas;
        if (thumbnailHotkey) {
            nativeWindow.addEventListener("keydown", handleThumbnailKeyDown, true);
            nativeWindow.addEventListener("keyup", handleThumbnailKeyUp, true);
            nativeWindow.addEventListener("blur", handleThumbnailBlur, true);
        }
        var dispose = function() {
            if (thumbnailHotkey) {
                nativeWindow.removeEventListener("keydown", handleThumbnailKeyDown, true);
                nativeWindow.removeEventListener("keyup", handleThumbnailKeyUp, true);
                nativeWindow.removeEventListener("blur", handleThumbnailBlur, true);
            }
            hideThumbnailCanvas();
        };
        canvas.__kapplusDispose = dispose;
        var originalRenderInstances = renderInstances;
        renderInstances = function(instances) {
            originalRenderInstances(instances);
            if (thumbnailHeld) {
                copyToThumbnailCanvas();
            }
        };
        var thumbnail = function(thumbnailOptions) {
            thumbnailOptions = thumbnailOptions || {};
            if (thumbnailOptions.instances) {
                renderInstances(thumbnailOptions.instances);
            } else {
                render(thumbnailOptions.yaw || 0, thumbnailOptions.pitch || 0);
            }
            return canvas.toDataURL(
                thumbnailOptions.type || "image/png",
                thumbnailOptions.quality === undefined ? 0.92 : thumbnailOptions.quality
            );
        };
        return ({
            canvas: canvas,
            gl: gl,
            stats: stats,

            render: render,
            renderInstances: renderInstances,
            thumbnail: thumbnail,
            showThumbnail: showThumbnailCanvas,
            hideThumbnail: hideThumbnailCanvas,
            dispose: dispose,

            sourceTextureCount: uploadedTextures.length,
            triangleCount: meshData.triangleCount,
            pixelRatio: pixelRatio
        });
    };
    var buildWebRTCPeer = function(nativeWindow, options, peerRegistry) {
        options = options || {};
        var PeerConnectionType = nativeWindow.RTCPeerConnection ||
            nativeWindow.webkitRTCPeerConnection;
        if (!PeerConnectionType) {
            throw new Error("KAP+ WebRTC is unavailable");
        }
        var configuration = {
            iceServers: options.iceServers || [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun.cloudflare.com:3478" }
            ]
        };
        var connection = new PeerConnectionType(configuration);
        var channel = null;
        var closed = false;
        var api = {
            state: "new",
            role: "",
            error: "",
            localCodeLength: 0,
            remoteCodeLength: 0,
            onState: null,
            onMessage: null,
            onOpen: null
        };
        var emitState = function(state) {
            api.state = state;
            if (api.onState) {
                api.onState(state);
            }
            if (options.onState) {
                options.onState(state);
            }
        };
        var fail = function(error, callback) {
            api.error = error && error.message ? error.message : String(error);
            emitState("error");
            if (callback) {
                callback(api.error, null);
            }
        };
        var encodeDescription = function(description) {
            var value = nativeWindow.JSON.stringify({
                v: 1,
                type: description.type,
                sdp: description.sdp
            });
            return nativeWindow.btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        };
        var decodeDescription = function(code) {
            var normalized = String(code || "").replace(/\s+/g, "")
                .replace(/-/g, "+").replace(/_/g, "/");
            while (normalized.length % 4) {
                normalized += "=";
            }
            var value = nativeWindow.JSON.parse(nativeWindow.atob(normalized));
            if (value.v !== 1 || (value.type !== "offer" && value.type !== "answer") ||
                typeof value.sdp !== "string") {
                throw new Error("Invalid KAP+ connection code");
            }
            return ({ type: value.type, sdp: value.sdp });
        };
        var channelOptions = { ordered: options.ordered !== false };
        if (options.maxRetransmits !== undefined) {
            channelOptions.maxRetransmits = options.maxRetransmits;
        }
        if (options.maxPacketLifeTime !== undefined) {
            channelOptions.maxPacketLifeTime = options.maxPacketLifeTime;
        }
        var attachChannel = function(nextChannel) {
            channel = nextChannel;
            channel.onopen = function() {
                emitState("connected");
                if (api.onOpen) {
                    api.onOpen();
                }
                if (options.onOpen) {
                    options.onOpen();
                }
            };
            channel.onmessage = function(event) {
                if (api.onMessage) {
                    api.onMessage(event.data);
                }
                if (options.onMessage) {
                    options.onMessage(event.data);
                }
            };
            channel.onerror = function() {
                api.error = "WebRTC data channel error";
                emitState("error");
            };
            channel.onclose = function() {
                if (!closed) {
                    emitState("disconnected");
                }
            };
        };
        connection.ondatachannel = function(event) {
            attachChannel(event.channel);
        };
        connection.onconnectionstatechange = function() {
            var state = connection.connectionState;
            if (state === "failed") {
                api.error = "WebRTC connection failed";
                emitState("error");
            } else if (state === "disconnected") {
                emitState("disconnected");
            } else if (state === "closed") {
                emitState("closed");
            } else if (state === "connecting") {
                emitState("connecting");
            }
        };
        var waitForIce = function(callback) {
            if (connection.iceGatheringState === "complete") {
                callback();
                return;
            }
            var finished = false;
            var finish = function() {
                if (finished) {
                    return;
                }
                finished = true;
                connection.removeEventListener("icegatheringstatechange", check);
                callback();
            };
            var check = function() {
                if (connection.iceGatheringState === "complete") {
                    finish();
                }
            };
            connection.addEventListener("icegatheringstatechange", check);
            nativeWindow.setTimeout(finish, options.iceTimeout || 8000);
        };
        api.createOffer = function(callback) {
            api.role = "host";
            emitState("creating offer");
            attachChannel(connection.createDataChannel(options.channel || "kapplus", channelOptions));
            connection.createOffer()["then"](function(description) {
                return connection.setLocalDescription(description);
            })["then"](function() {
                emitState("gathering connection details");
                waitForIce(function() {
                    var code = encodeDescription(connection.localDescription);
                    api.localCodeLength = code.length;
                    emitState("offer ready");
                    callback(null, code);
                });
            })["catch"](function(error) {
                fail(error, callback);
            });
        };
        api.acceptOffer = function(code, callback) {
            var description;
            try {
                description = decodeDescription(code);
                if (description.type !== "offer") {
                    throw new Error("Expected a KAP+ offer code");
                }
            } catch (error) {
                fail(error, callback);
                return;
            }
            api.role = "guest";
            api.remoteCodeLength = String(code).replace(/\s+/g, "").length;
            emitState("accepting offer");
            connection.setRemoteDescription(description)["then"](function() {
                return connection.createAnswer();
            })["then"](function(answer) {
                return connection.setLocalDescription(answer);
            })["then"](function() {
                emitState("gathering connection details");
                waitForIce(function() {
                    var answerCode = encodeDescription(connection.localDescription);
                    api.localCodeLength = answerCode.length;
                    emitState("answer ready");
                    callback(null, answerCode);
                });
            })["catch"](function(error) {
                fail(error, callback);
            });
        };
        api.acceptAnswer = function(code, callback) {
            var description;
            try {
                description = decodeDescription(code);
                if (description.type !== "answer") {
                    throw new Error("Expected a KAP+ answer code");
                }
            } catch (error) {
                fail(error, callback);
                return;
            }
            api.remoteCodeLength = String(code).replace(/\s+/g, "").length;
            emitState("accepting answer");
            connection.setRemoteDescription(description)["then"](function() {
                emitState("connecting");
                if (callback) {
                    callback(null);
                }
            })["catch"](function(error) {
                fail(error, callback);
            });
        };
        api.send = function(value) {
            if (!channel || channel.readyState !== "open") {
                return false;
            }
            channel.send(typeof value === "string" ? value : nativeWindow.JSON.stringify(value));
            return true;
        };
        api.close = function() {
            if (closed) {
                return;
            }
            closed = true;
            if (channel) {
                channel.close();
            }
            connection.close();
            if (peerRegistry) {
                peerRegistry.remove(api);
            }
            emitState("closed");
        };
        api.connection = connection;
        if (peerRegistry) {
            peerRegistry.add(api);
        }
        return api;
    };
    buildCodePanel = function(nativeWindow, nativeDocument, label, value, complete) {
        var existing = nativeDocument.getElementById("kapplus-code-panel");
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
        var backdrop = nativeDocument.createElement("div");
        backdrop.id = "kapplus-code-panel";
        backdrop.style.position = "fixed";
        backdrop.style.left = "0";
        backdrop.style.top = "0";
        backdrop.style.right = "0";
        backdrop.style.bottom = "0";
        backdrop.style.zIndex = "2147483647";
        backdrop.style.background = "rgba(20,24,31,0.48)";
        backdrop.style.display = "flex";
        backdrop.style.alignItems = "center";
        backdrop.style.justifyContent = "center";
        var panel = nativeDocument.createElement("div");
        panel.style.width = "min(520px, calc(100% - 32px))";
        panel.style.boxSizing = "border-box";
        panel.style.padding = "20px";
        panel.style.background = "#f6f4ef";
        panel.style.border = "1px solid #c9c7c1";
        panel.style.borderRadius = "8px";
        panel.style.boxShadow = "0 2px 8px rgba(0,0,0,0.16)";
        panel.style.fontFamily = "system-ui, sans-serif";
        var labelElement = nativeDocument.createElement("div");
        labelElement.textContent = label;
        labelElement.style.color = "#14181f";
        labelElement.style.fontSize = "14px";
        labelElement.style.fontWeight = "600";
        labelElement.style.marginBottom = "10px";
        var textarea = nativeDocument.createElement("textarea");
        textarea.value = value || "";
        textarea.wrap = "off";
        textarea.spellcheck = false;
        textarea.style.display = "block";
        textarea.style.width = "100%";
        textarea.style.height = "180px";
        textarea.style.boxSizing = "border-box";
        textarea.style.padding = "10px";
        textarea.style.resize = "vertical";
        textarea.style.border = "1px solid #9d9b96";
        textarea.style.borderRadius = "6px";
        textarea.style.background = "#ffffff";
        textarea.style.color = "#14181f";
        textarea.style.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
        textarea.style.outline = "none";
        var actions = nativeDocument.createElement("div");
        actions.style.display = "flex";
        actions.style.justifyContent = "flex-end";
        actions.style.gap = "8px";
        actions.style.marginTop = "12px";
        var makeButton = function(text, primary) {
            var button = nativeDocument.createElement("button");
            button.type = "button";
            button.textContent = text;
            button.style.padding = "8px 14px";
            button.style.border = primary ? "1px solid #2f6f9f" : "1px solid #9d9b96";
            button.style.borderRadius = "6px";
            button.style.background = primary ? "#387eb5" : "#ffffff";
            button.style.color = primary ? "#ffffff" : "#30343b";
            button.style.font = "600 13px system-ui, sans-serif";
            button.style.cursor = "pointer";
            return button;
        };
        var cancel = makeButton("Cancel", false);
        var done = makeButton(value ? "Close" : "Use code", true);
        var close = function(result) {
            if (backdrop.parentNode) {
                backdrop.parentNode.removeChild(backdrop);
            }
            if (complete) {
                complete(result);
            }
        };
        cancel.onclick = function() { close(null); };
        done.onclick = function() { close(textarea.value); };
        if (value) {
            var copy = makeButton("Copy", false);
            copy.onclick = function() {
                textarea.focus();
                textarea.select();
                try {
                    copy.textContent = nativeDocument.execCommand("copy")
                        ? "Copied" : "Press Ctrl+C";
                } catch (copyError) {
                    copy.textContent = "Press Ctrl+C";
                }
            };
            actions.appendChild(copy);
        }
        actions.appendChild(cancel);
        actions.appendChild(done);
        panel.appendChild(labelElement);
        panel.appendChild(textarea);
        panel.appendChild(actions);
        backdrop.appendChild(panel);
        nativeDocument.body.appendChild(backdrop);
        textarea.focus();
        if (value) {
            textarea.select();
        }
        return ({ close: function() { close(null); }, textarea: textarea });
    };
${networkRuntime}
    var makeApi = function(audio) {
        return ({
            mesh: mesh,
            texture: texture,
            audio: audio,
            imageFromPixels: imageFromPixels,
            whenReady: whenReady,
            createWebGLRenderer: makeWebGLRenderer,
            createPeer: makeWebRTCPeer,
            createNetwork: makeNetwork,
            promptCode: promptForCode
        });
    };
`;

const localAudioRuntime = String.raw`
    runtimeGlobal = typeof window !== "undefined" ? window : null;
    decodeBase64 = function(data) { return atob(data); };
    loadTextureSource = function(data, complete) {
        var imageElement = new Image();
        imageElement.onload = function() {
            var canvasElement = document.createElement("canvas");
            canvasElement.width = data.width;
            canvasElement.height = data.height;
            var context = canvasElement.getContext("2d");
            context.drawImage(imageElement, 0, 0);
            complete(context.getImageData(0, 0, data.width, data.height).data);
        };
        imageElement.onerror = function() { throw new Error("Could not decode source PNG texture"); };
        imageElement.src = "data:image/png;base64," + data.sourceData;
    };
    makeTextureImage = function(data, decode) {
        var result = createImage(data.width, data.height, ARGB);
        for (var index = 0; index < data.packedPixels.length; index++) {
            var rgba = decode(data.packedPixels[index], data.pixelFormat);
            result.set(
                index % data.width,
                floor(index / data.width),
                color(rgba[0], rgba[1], rgba[2], rgba[3])
            );
        }
        return result;
    };
    var audio = function(data, byteLength) {
        var element = null;
        var objectUrl = null;
        return ({
            state: "idle",
            duration: 0,
            play: function() {
                if (!element) {
                    var bytes = new Uint8Array(byteLength);
                    decodeBase85Into(data, bytes, byteLength);
                    objectUrl = URL.createObjectURL(new Blob([bytes], ({ type: "audio/mpeg" })));
                    element = new Audio(objectUrl);
                }
                element.currentTime = 0;
                this.state = "playing";
                var asset = this;
                element.onloadedmetadata = function() { asset.duration = element.duration; };
                element.onended = function() { asset.state = "ended"; };
                element.play();
            },
            stop: function() {
                if (element) {
                    element.pause();
                    element.currentTime = 0;
                }
                this.state = "stopped";
            }
        });
    };
    makeWebGLRenderer = function(options) {
        return buildWebGLRenderer(window, document, options);
    };
    var localPeerEntries = [];
    var localPeerRegistry = {
        add: function(peer) { localPeerEntries.push(peer); },
        remove: function(peer) {
            var index = localPeerEntries.indexOf(peer);
            if (index >= 0) { localPeerEntries.splice(index, 1); }
        }
    };
    makeWebRTCPeer = function(options) {
        return buildWebRTCPeer(window, options, localPeerRegistry);
    };
    promptForCode = function(label, value, complete) {
        return buildCodePanel(window, document, label, value, complete);
    };
    var localNetworkRegistry = buildNetworkRegistry();
    makeNetwork = function(options) {
        return buildNetworkClient(window, document, false, options, localNetworkRegistry);
    };
    return makeApi(audio);
})();
`;

const khanBridgeRuntime = String.raw`
    var joinWords = function(first, second) { return first + second; };
    var carrier = getSound("rpg/metal-clink");
    var audioDocument = carrier.audio[joinWords("owner", "Document")];
    var audioWindow = audioDocument[joinWords("default", "View")];
    runtimeGlobal = audioWindow;
    var networkRegistryKey = joinWords("__kapplus", "NetworkRegistry");
    var previousNetworkRegistry = audioWindow[networkRegistryKey];
    if (previousNetworkRegistry && previousNetworkRegistry.closeAll) {
        previousNetworkRegistry.closeAll();
    }
    var networkRegistry = buildNetworkRegistry();
    audioWindow[networkRegistryKey] = networkRegistry;
    makeNetwork = function(options) {
        return buildNetworkClient(audioWindow, audioDocument, true, options, networkRegistry);
    };
    var getCodePanel = audioDocument[joinWords("getElement", "ById")];
    var previousCodePanel = getCodePanel
        ? getCodePanel.call(audioDocument, "kapplus-code-panel") : null;
    if (previousCodePanel && previousCodePanel.parentNode) {
        previousCodePanel.parentNode[joinWords("remove", "Child")](previousCodePanel);
    }
    var audioRegistryKey = joinWords("__kapplus", "AudioRegistry");
    var previousAudioRegistry = audioWindow[audioRegistryKey];
    if (previousAudioRegistry && previousAudioRegistry.stopAll) {
        previousAudioRegistry.stopAll();
    }
    var activeAudioEntries = [];
    var audioRegistry = {
        add: function(entry) {
            activeAudioEntries.push(entry);
        },
        remove: function(entry) {
            for (var index = activeAudioEntries.length - 1; index >= 0; index--) {
                if (activeAudioEntries[index] === entry) {
                    activeAudioEntries.splice(index, 1);
                }
            }
        },
        stopAll: function() {
            while (activeAudioEntries.length > 0) {
                var entry = activeAudioEntries[activeAudioEntries.length - 1];
                try {
                    entry.stop();
                } catch (stopError) {
                    activeAudioEntries.pop();
                }
            }
        }
    };
    audioWindow[audioRegistryKey] = audioRegistry;
    var peerRegistryKey = joinWords("__kapplus", "PeerRegistry");
    var previousPeerRegistry = audioWindow[peerRegistryKey];
    if (previousPeerRegistry && previousPeerRegistry.closeAll) {
        previousPeerRegistry.closeAll();
    }
    var activePeerEntries = [];
    var peerRegistry = {
        add: function(peer) { activePeerEntries.push(peer); },
        remove: function(peer) {
            for (var peerIndex = activePeerEntries.length - 1; peerIndex >= 0; peerIndex--) {
                if (activePeerEntries[peerIndex] === peer) {
                    activePeerEntries.splice(peerIndex, 1);
                }
            }
        },
        closeAll: function() {
            while (activePeerEntries.length > 0) {
                activePeerEntries[activePeerEntries.length - 1].close();
            }
        }
    };
    audioWindow[peerRegistryKey] = peerRegistry;
    var ContextType = audioWindow[joinWords("Audio", "Context")] ||
        audioWindow[joinWords("webkit", "AudioContext")];
    var ReflectType = audioWindow[joinWords("Re", "flect")];
    var BytesType = audioWindow[joinWords("Uint8", "Array")];
    var ClampedBytesType = audioWindow[joinWords("Uint8Clamped", "Array")];
    var ImageDataType = audioWindow[joinWords("Image", "Data")];
    var BlobType = audioWindow[joinWords("Bl", "ob")];
    var createImageBitmapType = audioWindow[joinWords("create", "ImageBitmap")];
    decodeBase64 = function(data) { return audioWindow[joinWords("a", "tob")](data); };
    loadTextureSource = function(data, complete) {
        var source = decodeBase64(data.sourceData);
        var sourceBytes = ReflectType[joinWords("con", "struct")](BytesType, [source.length]);
        for (var sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
            sourceBytes[sourceIndex] = source.charCodeAt(sourceIndex);
        }
        var blob = ReflectType[joinWords("con", "struct")](
            BlobType,
            [[sourceBytes], { type: "image/png" }]
        );
        createImageBitmapType.call(audioWindow, blob)["then"](function(imageElement) {
            var canvasElement = audioDocument[joinWords("create", "Element")]("canvas");
            canvasElement.width = data.width;
            canvasElement.height = data.height;
            var context = canvasElement[joinWords("get", "Context")]("2d");
            context[joinWords("draw", "Image")](imageElement, 0, 0);
            var imageData = context[joinWords("get", "ImageData")](
                0,
                0,
                data.width,
                data.height
            );
            complete(imageData.data);
            if (imageElement.close) {
                imageElement.close();
            }
        }, function() { throw new Error("Could not decode source PNG texture"); });
    };
    makeTextureImage = function(data, decode) {
        var byteCount = data.width * data.height * 4;
        var imageBytes = ReflectType[joinWords("con", "struct")](ClampedBytesType, [byteCount]);
        for (var index = 0; index < data.packedPixels.length; index++) {
            var rgba = decode(data.packedPixels[index], data.pixelFormat);
            var offset = index * 4;
            imageBytes[offset] = rgba[0];
            imageBytes[offset + 1] = rgba[1];
            imageBytes[offset + 2] = rgba[2];
            imageBytes[offset + 3] = rgba[3];
        }
        var nativeImageData = ReflectType[joinWords("con", "struct")](
            ImageDataType,
            [imageBytes, data.width, data.height]
        );
        var result = createImage(data.width, data.height, ARGB);
        result.fromImageData(nativeImageData);
        return result;
    };
    makeWebGLRenderer = function(options) {
        return buildWebGLRenderer(audioWindow, audioDocument, options);
    };
    makeWebRTCPeer = function(options) {
        return buildWebRTCPeer(audioWindow, options, peerRegistry);
    };
    promptForCode = function(label, value, complete) {
        return buildCodePanel(audioWindow, audioDocument, label, value, complete);
    };
`;

const khanAudioRuntime = String.raw`
    var audio = function(data, byteLength) {
        var context = null;
        var source = null;
        var playbackEntry = null;
        var asset = ({
            state: "idle",
            duration: 0,
            play: function() {
                asset.stop();
                context = ReflectType[joinWords("con", "struct")](ContextType, []);
                var contextForPlayback = context;
                var entry = {
                    context: contextForPlayback,
                    source: null,
                    stopped: false,
                    stop: function() {
                        if (entry.stopped) {
                            return;
                        }
                        entry.stopped = true;
                        if (entry.source) {
                            try { entry.source.stop(0); } catch (stopError) {}
                            entry.source = null;
                        }
                        if (entry.context && entry.context.state !== "closed") {
                            try { entry.context.close(); } catch (closeError) {}
                        }
                        audioRegistry.remove(entry);
                        if (playbackEntry === entry) {
                            source = null;
                            context = null;
                            playbackEntry = null;
                        }
                    }
                };
                playbackEntry = entry;
                audioRegistry.add(entry);
                var bytes = ReflectType[joinWords("con", "struct")](BytesType, [byteLength]);
                decodeBase85Into(data, bytes, byteLength);
                asset.state = "decoding";
                contextForPlayback.decodeAudioData(bytes.buffer, function(decoded) {
                    if (entry.stopped || contextForPlayback.state === "closed") {
                        return;
                    }
                    var sourceForPlayback = contextForPlayback.createBufferSource();
                    source = sourceForPlayback;
                    entry.source = sourceForPlayback;
                    sourceForPlayback.buffer = decoded;
                    sourceForPlayback.connect(contextForPlayback.destination);
                    asset.duration = decoded.duration;
                    sourceForPlayback.onended = function() {
                        if (entry.stopped) {
                            return;
                        }
                        entry.stopped = true;
                        audioRegistry.remove(entry);
                        if (contextForPlayback.state !== "closed") {
                            try { contextForPlayback.close(); } catch (closeError) {}
                        }
                        if (playbackEntry === entry) {
                            asset.state = "ended";
                            source = null;
                            context = null;
                            playbackEntry = null;
                        }
                    };
                    sourceForPlayback.start(0);
                    asset.state = "playing";
                }, function() {
                    if (entry.stopped) {
                        return;
                    }
                    entry.stopped = true;
                    audioRegistry.remove(entry);
                    if (contextForPlayback.state !== "closed") {
                        try { contextForPlayback.close(); } catch (closeError) {}
                    }
                    if (playbackEntry === entry) {
                        source = null;
                        context = null;
                        playbackEntry = null;
                    }
                    asset.state = "error";
                });
            },
            stop: function() {
                if (playbackEntry) {
                    playbackEntry.stop();
                }
                if (asset.state !== "idle") {
                    asset.state = "stopped";
                }
            }
        });
        return asset;
    };
    return makeApi(audio);
})();
`;

export function runtimeFor(target: KapPlusTarget, hasAudio: boolean): string {
  if (target === "local") return sharedRuntime + localAudioRuntime;
  if (hasAudio) return sharedRuntime + khanBridgeRuntime + khanAudioRuntime;
  return (
    sharedRuntime +
    khanBridgeRuntime +
    String.raw`
    var audio = function() {
        return ({ state: "unavailable", duration: 0, play: function() {}, stop: function() {} });
    };
    return makeApi(audio);
})();
`
  );
}
