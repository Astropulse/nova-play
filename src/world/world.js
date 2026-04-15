// Scaling is dynamic via game properties

// Seeded pseudo-random for deterministic star placement
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

export class World {
    constructor(game, seed = 42) {
        this.game = game;
        this.virtualSize = 4096; // Standard virtual size
        this.seed = seed;

        // Assets
        this.starImages = [];
        for (let i = 0; i <= 7; i++) this.starImages.push(game.assets.get(`starfield_${i}`));

        this.rareImages = [
            game.assets.get('big_star'), game.assets.get('galaxy'),
            game.assets.get('nebula_0'), game.assets.get('nebula_1'),
            game.assets.get('nebula_2'), game.assets.get('nebula_3'),
        ];
        this.blackHoleImage = game.assets.get('black_hole');
        this.singleStars = [];
        for (let i = 0; i <= 10; i++) {
            const img = game.assets.get(`star_${i}`);
            if (img) this.singleStars.push(img);
        }

        this.layers = [];
        
        // Setup WebGL
        this._initWebGL();
        this._initLayers();
    }

    _initWebGL() {
        // Only create the canvas once; reuse on context restore
        if (!this.glCanvas) {
            this.glCanvas = document.createElement('canvas');
            this._glContextLost = false;

            // Handle WebGL context loss/restore — prevents persistent slowdowns
            this.glCanvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault(); // Allow restoration
                this._glContextLost = true;
                console.warn('[World] WebGL context lost');
            });
            this.glCanvas.addEventListener('webglcontextrestored', () => {
                console.log('[World] WebGL context restored — reinitializing');
                this._glContextLost = false;
                this._setupWebGLResources();
                this._initLayers();
            });

            this.gl = this.glCanvas.getContext('webgl2', {
                alpha: true,
                depth: false,
                antialias: false,
                premultipliedAlpha: true,
                powerPreference: 'high-performance'
            });

            if (!this.gl) {
                console.error("WebGL2 not supported, parallax background will fail to render.");
                return;
            }
        }

        this._setupWebGLResources();
    }

    _setupWebGLResources() {
        if (!this.gl) return;

        const gl = this.gl;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

        // --- Build Texture Atlas ---
        // Collect all unique images
        const allImages = new Set();
        this.starImages.forEach(img => { if(img) allImages.add(img); });
        this.rareImages.forEach(img => { if(img) allImages.add(img); });
        this.singleStars.forEach(img => { if(img) allImages.add(img); });
        if (this.blackHoleImage) allImages.add(this.blackHoleImage);

        // Dynamic atlas packer
        const packTest = (width) => {
            let cx = 0, cy = 0, rH = 0;
            for (const img of allImages) {
                const drawW = (img.canvas || img).width;
                const drawH = (img.canvas || img).height;
                if (cx + drawW > width) {
                    cx = 0; cy += rH + 2; rH = 0;
                }
                cx += drawW + 2;
                rH = Math.max(rH, drawH);
            }
            return cy + rH + 2;
        };

        if (packTest(2048) <= 2048) { this.atlasWidth = 2048; this.atlasHeight = 2048; }
        else if (packTest(4096) <= 4096) { this.atlasWidth = 4096; this.atlasHeight = 4096; }
        else { this.atlasWidth = 8192; this.atlasHeight = 8192; }

        const atlasCanvas = document.createElement('canvas');
        atlasCanvas.width = this.atlasWidth;
        atlasCanvas.height = this.atlasHeight;
        const atlasCtx = atlasCanvas.getContext('2d');
        atlasCtx.imageSmoothingEnabled = false;

        this.uvMap = new Map(); // image -> { u, v, uWidth, vHeight, w, h }

        let curX = 0;
        let curY = 0;
        let rowHeight = 0;

        allImages.forEach(img => {
            const atlasImg = img.canvas || img;
            const drawW = atlasImg.width;
            const drawH = atlasImg.height;

            if (curX + drawW > this.atlasWidth) {
                curX = 0;
                curY += rowHeight + 2; // +padding to prevent sampler edge bleeding
                rowHeight = 0;
            }
            // Draw into atlas
            atlasCtx.drawImage(atlasImg, curX, curY);

            // Save UV info - keeping logical widths for geometry
            this.uvMap.set(img, {
                w: img.width || drawW,
                h: img.height || drawH,
                u: curX / this.atlasWidth,
                v: curY / this.atlasHeight,
                uWidth: drawW / this.atlasWidth,
                vHeight: drawH / this.atlasHeight
            });

            curX += drawW + 2;
            rowHeight = Math.max(rowHeight, drawH);
        });

        // Create WebGL Texture
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // --- Shaders ---
        const vsSource = `#version 300 es
        in vec2 a_position;
        in vec2 a_offset;
        in vec4 a_texCoords;
        in vec2 a_size;
        in float a_alphaBoost;
        in float a_rotation;

        uniform vec2 u_resolution;
        uniform vec2 u_cameraXY;
        uniform float u_parallax;
        uniform float u_worldScale;
        uniform vec2 u_wrapOffset;
        uniform vec2 u_streakOffset;
        uniform float u_virtualSize;
        uniform vec2 u_atlasSize;

        out vec2 v_texCoord;
        out float v_alphaBoost;

        void main() {
            float relX = a_offset.x - (u_cameraXY.x * u_parallax);
            relX = mod(relX, u_virtualSize);
            if(relX < 0.0) relX += u_virtualSize;
            float halfSize = u_virtualSize / 2.0;
            if(relX < -halfSize) relX += u_virtualSize;
            if(relX > halfSize) relX -= u_virtualSize;

            float relY = a_offset.y - (u_cameraXY.y * u_parallax);
            relY = mod(relY, u_virtualSize);
            if(relY < 0.0) relY += u_virtualSize;
            if(relY < -halfSize) relY += u_virtualSize;
            if(relY > halfSize) relY -= u_virtualSize;

            float sx = relX + u_wrapOffset.x * u_virtualSize;
            float sy = relY + u_wrapOffset.y * u_virtualSize;

            float cw = u_resolution.x;
            float ch = u_resolution.y;
            
            // Allow sub-pixel floats to let GPU antialiasing glide the art smoothly
            float dx = sx * u_worldScale + (cw / 2.0);
            float dy = sy * u_worldScale + (ch / 2.0);

            float finalX = dx + u_streakOffset.x;
            float finalY = dy + u_streakOffset.y;

            // Preserve unrounded size for exact float bounds scaling
            float sw = a_size.x * u_worldScale;
            float sh = a_size.y * u_worldScale;
            
            float cosR = cos(a_rotation);
            float sinR = sin(a_rotation);
            
            float px = a_position.x * sw;
            float py = a_position.y * sh;
            
            float rx = px * cosR - py * sinR;
            float ry = px * sinR + py * cosR;

            vec2 screenPos = vec2(finalX + rx, finalY + ry);
            
            vec2 clipSpace = (screenPos / u_resolution) * 2.0 - 1.0;
            clipSpace.y = -clipSpace.y;

            gl_Position = vec4(clipSpace, 0.0, 1.0);
            
            vec2 uvBase = a_position + 0.5;
            vec2 halfTexel = vec2(0.5) / u_atlasSize;
            
            float u = a_texCoords.x + uvBase.x * a_texCoords.z;
            float v = a_texCoords.y + uvBase.y * a_texCoords.w;
            
            // Limit sampling firmly into exact pre-scaled atlas sprite bounds, averting smoothing bleed 
            u = clamp(u, a_texCoords.x + halfTexel.x, a_texCoords.x + a_texCoords.z - halfTexel.x);
            v = clamp(v, a_texCoords.y + halfTexel.y, a_texCoords.y + a_texCoords.w - halfTexel.y);
            
            v_texCoord = vec2(u, v);
            v_alphaBoost = a_alphaBoost;
        }`;

        const fsSource = `#version 300 es
        precision highp float;
        
        in vec2 v_texCoord;
        in float v_alphaBoost;
        
        uniform sampler2D u_texture;
        uniform float u_globalAlpha;
        uniform int u_isBlackHole;
        
        out vec4 outColor;
        
        void main() {
            vec4 texColor = texture(u_texture, v_texCoord);
            float alphaMult = u_isBlackHole == 1 ? 1.0 : (v_alphaBoost * u_globalAlpha);
            outColor = texColor * alphaMult;
        }`;

        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vsSource);
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vertexShader));

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fsSource);
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fragmentShader));

        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        // Location lookups
        this.locs = {
            a_position: gl.getAttribLocation(this.program, "a_position"),
            a_offset: gl.getAttribLocation(this.program, "a_offset"),
            a_texCoords: gl.getAttribLocation(this.program, "a_texCoords"),
            a_size: gl.getAttribLocation(this.program, "a_size"),
            a_alphaBoost: gl.getAttribLocation(this.program, "a_alphaBoost"),
            a_rotation: gl.getAttribLocation(this.program, "a_rotation"),
            
            u_resolution: gl.getUniformLocation(this.program, "u_resolution"),
            u_cameraXY: gl.getUniformLocation(this.program, "u_cameraXY"),
            u_parallax: gl.getUniformLocation(this.program, "u_parallax"),
            u_worldScale: gl.getUniformLocation(this.program, "u_worldScale"),
            u_wrapOffset: gl.getUniformLocation(this.program, "u_wrapOffset"),
            u_streakOffset: gl.getUniformLocation(this.program, "u_streakOffset"),
            u_virtualSize: gl.getUniformLocation(this.program, "u_virtualSize"),
            u_atlasSize: gl.getUniformLocation(this.program, "u_atlasSize"),
            u_globalAlpha: gl.getUniformLocation(this.program, "u_globalAlpha"),
            u_isBlackHole: gl.getUniformLocation(this.program, "u_isBlackHole"),
            u_texture: gl.getUniformLocation(this.program, "u_texture"),
        };

        // Quad Base
        this.quadVao = gl.createVertexArray();
        gl.bindVertexArray(this.quadVao);

        const quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -0.5, -0.5,
             0.5, -0.5,
            -0.5,  0.5,
            -0.5,  0.5,
             0.5, -0.5,
             0.5,  0.5
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.locs.a_position);
        gl.vertexAttribPointer(this.locs.a_position, 2, gl.FLOAT, false, 0, 0);

        this.instanceBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);

        // Instance Layout
        const stride = (2 + 4 + 2 + 1 + 1) * 4; // 10 floats = 40 bytes
        
        gl.enableVertexAttribArray(this.locs.a_offset);
        gl.vertexAttribPointer(this.locs.a_offset, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(this.locs.a_offset, 1);

        gl.enableVertexAttribArray(this.locs.a_texCoords);
        gl.vertexAttribPointer(this.locs.a_texCoords, 4, gl.FLOAT, false, stride, 8);
        gl.vertexAttribDivisor(this.locs.a_texCoords, 1);

        gl.enableVertexAttribArray(this.locs.a_size);
        gl.vertexAttribPointer(this.locs.a_size, 2, gl.FLOAT, false, stride, 24);
        gl.vertexAttribDivisor(this.locs.a_size, 1);

        gl.enableVertexAttribArray(this.locs.a_alphaBoost);
        gl.vertexAttribPointer(this.locs.a_alphaBoost, 1, gl.FLOAT, false, stride, 32);
        gl.vertexAttribDivisor(this.locs.a_alphaBoost, 1);

        gl.enableVertexAttribArray(this.locs.a_rotation);
        gl.vertexAttribPointer(this.locs.a_rotation, 1, gl.FLOAT, false, stride, 36);
        gl.vertexAttribDivisor(this.locs.a_rotation, 1);
        
        gl.bindVertexArray(null);
    }

    _initLayers() {
        if(!this.gl) return; // Fallback handled outside
        
        const layerConfigs = [
            { parallax: 0.02, count: 320, alpha: 0.25, singleStarCount: 160 },
            { parallax: 0.05, count: 200, alpha: 0.35, singleStarCount: 200 },
            { parallax: 0.10, count: 160, alpha: 0.45, singleStarCount: 240 },
            { parallax: 0.18, count: 120, alpha: 0.60, singleStarCount: 160 },
            { parallax: 0.28, count: 80, alpha: 0.75, singleStarCount: 80 },
            { parallax: 0.40, count: 60, alpha: 0.90, singleStarCount: 40 },
            { parallax: 0.55, count: 40, alpha: 1.0, singleStarCount: 20 },
        ];

        const rng = mulberry32(this.seed);
        let rarePool = [];
        const refillPool = () => {
            rarePool = Array.from({ length: this.rareImages.length }, (_, i) => i);
            for (let i = rarePool.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [rarePool[i], rarePool[j]] = [rarePool[j], rarePool[i]];
            }
        };
        refillPool();

        layerConfigs.forEach((config, idx) => {
            const starsLighter = [];
            const starsSourceOver = [];
            const starsScreen = [];

            // Gen regular stars
            for (let i = 0; i < config.count + config.singleStarCount; i++) {
                const isCluster = i < config.count;
                const assetList = isCluster ? this.starImages : this.singleStars;
                const imgAsset = assetList[Math.floor(rng() * assetList.length)];
                
                starsLighter.push({
                    x: rng() * this.virtualSize,
                    y: rng() * this.virtualSize,
                    img: imgAsset,
                    blend: 'lighter',
                    rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                    alphaBoost: 0.8 + rng() * 0.4
                });
            }

            // Rare objects
            if (idx >= 1 && idx <= 4) {
                const rareCount = Math.floor(rng() * 7) + 1;
                for (let r = 0; r < rareCount; r++) {
                    let imgAsset;
                    let blend = 'screen';
                    let isBlackHole = false;
                    if (rng() < 0.03 && this.blackHoleImage && idx == 1) {
                        imgAsset = this.blackHoleImage;
                        blend = 'source-over';
                        isBlackHole = true;
                    } else {
                        if (rarePool.length === 0) refillPool();
                        imgAsset = this.rareImages[rarePool.pop()];
                    }

                    if (imgAsset) {
                        const targetList = blend === 'source-over' ? starsSourceOver : starsScreen;
                        targetList.push({
                            x: rng() * this.virtualSize,
                            y: rng() * this.virtualSize,
                            img: imgAsset,
                            blend: blend,
                            isBlackHole: isBlackHole,
                            rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                            alphaBoost: isBlackHole ? 1.0 : (0.5 + rng() * 0.4)
                        });
                    }
                }
            }

            // Convert lists to TypedArrays
            const packBatch = (list, blendMode, isBh) => {
                const buffer = new Float32Array(list.length * 10);
                let off = 0;
                list.forEach(item => {
                    const uvInfo = this.uvMap.get(item.img);
                    if(!uvInfo) {
                        // Safe default to prevent crash
                        buffer[off++] = item.x; buffer[off++] = item.y;
                        buffer[off++] = 0; buffer[off++] = 0; buffer[off++] = 0; buffer[off++] = 0;
                        buffer[off++] = 0; buffer[off++] = 0;
                        buffer[off++] = 0; buffer[off++] = 0;
                        return;
                    } 
                    
                    buffer[off++] = item.x;
                    buffer[off++] = item.y;
                    
                    buffer[off++] = uvInfo.u;
                    buffer[off++] = uvInfo.v;
                    buffer[off++] = uvInfo.uWidth;
                    buffer[off++] = uvInfo.vHeight;
                    
                    buffer[off++] = uvInfo.w;
                    buffer[off++] = uvInfo.h;
                    
                    buffer[off++] = item.alphaBoost;
                    buffer[off++] = item.rotation;
                });
                return { count: list.length, buffer, blendMode, isBlackHole: isBh };
            };

            const batches = [];
            if (starsSourceOver.length) batches.push(packBatch(starsSourceOver, 'source-over', true));
            if (starsLighter.length) batches.push(packBatch(starsLighter, 'lighter', false));
            if (starsScreen.length) batches.push(packBatch(starsScreen, 'screen', false));

            // Load into GPU buffers immediately
            batches.forEach(b => {
                b.vbo = this.gl.createBuffer();
                this.gl.bindBuffer(this.gl.ARRAY_BUFFER, b.vbo);
                this.gl.bufferData(this.gl.ARRAY_BUFFER, b.buffer, this.gl.STATIC_DRAW);
            });

            this.layers.push({
                parallax: config.parallax,
                alpha: config.alpha,
                batches: batches
            });
        });
    }

    draw(ctx, camera, player, worldTime = 0) {
        if (!this.gl || this._glContextLost || this.gl.isContextLost()) return;
        
        const cw = ctx.canvas.width;
        const ch = ctx.canvas.height;
        const worldScale = this.game.worldScale;
        const boostIntensity = player ? player.boostIntensity : 0;
        const isBoosting = boostIntensity > 0.01;
        const streakFactor = 0.04;

        if (this.glCanvas.width !== cw || this.glCanvas.height !== ch) {
            this.glCanvas.width = cw;
            this.glCanvas.height = ch;
            this.gl.viewport(0, 0, cw, ch);
        }

        const gl = this.gl;
        gl.clearColor(0, 0, 0, 0); // fully transparent backing
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(this.program);
        gl.bindVertexArray(this.quadVao);

        gl.uniform2f(this.locs.u_resolution, cw, ch);
        gl.uniform2f(this.locs.u_cameraXY, camera.x, camera.y);
        gl.uniform1f(this.locs.u_worldScale, worldScale);
        gl.uniform1f(this.locs.u_virtualSize, this.virtualSize);
        gl.uniform2f(this.locs.u_atlasSize, this.atlasWidth, this.atlasHeight);

        const viewW = cw / worldScale;
        const viewH = ch / worldScale;
        const rangeX = Math.ceil(viewW / this.virtualSize / 2) + 1;
        const rangeY = Math.ceil(viewH / this.virtualSize / 2) + 1;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(this.locs.u_texture, 0);

        for (const layer of this.layers) {
            const layerAlpha = layer.alpha * (0.95 + 0.05 * Math.sin(worldTime * (1 + layer.parallax * 2)));
            gl.uniform1f(this.locs.u_parallax, layer.parallax);
            
            const samples = isBoosting ? 8 : 1;
            const svx = player ? -player.vx * layer.parallax * streakFactor * boostIntensity * worldScale : 0;
            const svy = player ? -player.vy * layer.parallax * streakFactor * boostIntensity * worldScale : 0;

            for (const batch of layer.batches) {
                // Determine blend
                gl.enable(gl.BLEND);
                if (batch.blendMode === 'source-over') {
                    // Normal canvas src-over mapping for premultiplied
                    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                } else if (batch.blendMode === 'lighter' || batch.blendMode === 'screen') {
                    // Lighter and approx screen on premultiplied
                    gl.blendFunc(gl.ONE, gl.ONE);
                }
                
                gl.uniform1i(this.locs.u_isBlackHole, batch.isBlackHole ? 1 : 0);

                // Bind pre-loaded VBO for instances
                gl.bindBuffer(gl.ARRAY_BUFFER, batch.vbo);
                const stride = (2 + 4 + 2 + 1 + 1) * 4;
                gl.vertexAttribPointer(this.locs.a_offset, 2, gl.FLOAT, false, stride, 0);
                gl.vertexAttribPointer(this.locs.a_texCoords, 4, gl.FLOAT, false, stride, 8);
                gl.vertexAttribPointer(this.locs.a_size, 2, gl.FLOAT, false, stride, 24);
                gl.vertexAttribPointer(this.locs.a_alphaBoost, 1, gl.FLOAT, false, stride, 32);
                gl.vertexAttribPointer(this.locs.a_rotation, 1, gl.FLOAT, false, stride, 36);

                for (let s = 0; s < samples; s++) {
                    const t = samples > 1 ? s / (samples - 1) : 0.5;
                    const weight = samples > 1 ? Math.sin(t * Math.PI) : 1.0;
                    const offsetMult = samples > 1 ? (s / samples) : 0;
                    const boostComp = samples > 1 ? (1.8 / samples) : 1.0;
                    let finalAlpha = batch.isBlackHole ? 1.0 : (layerAlpha * weight * boostComp);
                    
                    gl.uniform1f(this.locs.u_globalAlpha, finalAlpha);
                    gl.uniform2f(this.locs.u_streakOffset, svx * offsetMult, svy * offsetMult);

                    for (let k = -rangeX; k <= rangeX; k++) {
                        for (let m = -rangeY; m <= rangeY; m++) {
                            gl.uniform2f(this.locs.u_wrapOffset, k, m);
                            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
                        }
                    }
                }
            }
        }

        // Unbind VAO purely for safety
        gl.bindVertexArray(null);

        // Output to main context
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        // The glCanvas has no background so just draw it directly
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.drawImage(this.glCanvas, 0, 0);
        ctx.restore();

        // Draw Shops (Delegated to shop system as originally coded via loop)
        if (this.game.currentState.shops) {
            for (const shop of this.game.currentState.shops) {
                shop.draw(ctx, camera);
            }
        }
    }
}
