// Scaling is dynamic via game properties

// Seeded pseudo-random for deterministic star placement. Shared with the
// gameplay RNG infrastructure so the starfield and the run seed use one
// implementation.
import { mulberry32 } from '../engine/rng.js';
import { SETTINGS } from '../engine/settings.js';
import { SpriteBatch } from './spriteBatch.js';

// Baseline cull under the reduced-particles setting: hide half the ordinary
// stars (pre-shuffled list, so it's a uniform random subset). Combined with
// the dragon's story cull via max(), so neither undercuts the other.
const REDUCED_PARTICLES_STAR_CULL = 0.5;

// Star records live in an RGBA32F data texture (3 texels per star) that the
// vertex shader reads with texelFetch, so ONE instanced draw per batch can
// submit every (boost sample x wrap tile x star) copy: the shader decodes
// gl_InstanceID into those three indices itself. Vertex attributes can't do
// that — a divisor advances per instance, it can't repeat a star across copies
// in the sample -> wrap -> star order the source-over black holes rely on.
const STAR_DATA_TEX_W = 1024;   // texels per row (WebGL2 guarantees >= 2048)
const STAR_TEXELS_PER_STAR = 3;
// Wrap tiles a single draw can address (uniform ivec2 array). More than this
// (only at absurd FOV) falls back to one draw per sample per tile chunk.
const MAX_TILES_PER_DRAW = 64;
const BOOST_SAMPLES = 8;
// Conservative slack (world units) when rejecting wrap tiles: the shader's
// float mod() can land a hair outside [-V/2, V/2] at far camera coordinates.
const TILE_REJECT_SLACK_WORLD = 64;

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

        // Fraction of the ordinary stars hidden from the sky (0..1). The
        // dragon's arrival sweeps a third of the stars away (Rev 12:4); the
        // star lists are pre-shuffled so capping the drawn instance count
        // removes a spatially-uniform random subset. Rare objects
        // (nebulae/galaxies/black holes) are never culled.
        this.starCull = 0;

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

        // Per-star records (see STAR_DATA_TEX_W): texel 0 = offset.xy, uv.xy;
        // texel 1 = uv size, sprite size; texel 2 = alphaBoost, rotation.
        uniform highp sampler2D u_starData;
        uniform int u_starBase;     // first texel of this batch's records
        uniform int u_instCount;    // stars drawn per copy (starCull-capped)
        uniform int u_tileCount;    // wrap tiles addressed by this draw
        uniform ivec2 u_tiles[${MAX_TILES_PER_DRAW}];
        uniform int u_sampleBase;   // first boost sample in this draw
        uniform float u_sampleAlpha[${BOOST_SAMPLES}];
        uniform vec2 u_sampleStreak[${BOOST_SAMPLES}];

        uniform vec2 u_resolution;
        uniform vec2 u_center;
        uniform vec2 u_cameraXY;
        uniform float u_parallax;
        uniform float u_worldScale;
        uniform float u_virtualSize;
        uniform vec2 u_atlasSize;
        uniform float u_time;
        uniform float u_twinkle;

        out vec2 v_texCoord;
        out float v_alphaBoost;
        flat out float v_globalAlpha;

        void main() {
            // Instance order is sample -> wrap X -> wrap Y -> star, the exact
            // submission order of the old per-tile draw loop.
            int copy = gl_InstanceID / u_instCount;
            int star = gl_InstanceID - copy * u_instCount;
            int sIdx = copy / u_tileCount;
            int tile = copy - sIdx * u_tileCount;
            ivec2 wrap = u_tiles[tile];
            int smp = u_sampleBase + sIdx;
            int t0 = (u_starBase + star) * ${STAR_TEXELS_PER_STAR};
            vec4 d0 = texelFetch(u_starData, ivec2(t0 % ${STAR_DATA_TEX_W}, t0 / ${STAR_DATA_TEX_W}), 0);
            int t1 = t0 + 1;
            vec4 d1 = texelFetch(u_starData, ivec2(t1 % ${STAR_DATA_TEX_W}, t1 / ${STAR_DATA_TEX_W}), 0);
            int t2 = t0 + 2;
            vec4 d2 = texelFetch(u_starData, ivec2(t2 % ${STAR_DATA_TEX_W}, t2 / ${STAR_DATA_TEX_W}), 0);
            vec2 a_offset = d0.xy;
            vec4 a_texCoords = vec4(d0.zw, d1.xy);
            vec2 a_size = d1.zw;
            float a_alphaBoost = d2.x;
            float a_rotation = d2.y;
            vec2 u_wrapOffset = vec2(wrap);
            vec2 u_streakOffset = u_sampleStreak[smp];
            v_globalAlpha = u_sampleAlpha[smp];

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

            // Allow sub-pixel floats to let GPU antialiasing glide the art smoothly.
            // u_center is the viewport center in glCanvas pixels (= resolution/2
            // for a full-screen view, or the split-screen pane's center).
            float dx = sx * u_worldScale + u_center.x;
            float dy = sy * u_worldScale + u_center.y;

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

            // A hash-selected minority of stars pulsate slowly, each at its
            // own rate and phase (derived from its stable world offset).
            float h = fract(sin(dot(a_offset, vec2(12.9898, 78.233))) * 43758.5453);
            if (h > 0.82) {
                float tw = 0.5 + 0.5 * sin(u_time * (0.6 + h * 2.4) + h * 6.2831);
                v_alphaBoost *= 1.0 - u_twinkle * 0.55 * tw;
            }
        }`;

        const fsSource = `#version 300 es
        precision highp float;
        
        in vec2 v_texCoord;
        in float v_alphaBoost;
        flat in float v_globalAlpha;

        uniform sampler2D u_texture;
        uniform int u_isBlackHole;

        out vec4 outColor;

        void main() {
            vec4 texColor = texture(u_texture, v_texCoord);
            float alphaMult = u_isBlackHole == 1 ? 1.0 : (v_alphaBoost * v_globalAlpha);
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

            u_starData: gl.getUniformLocation(this.program, "u_starData"),
            u_starBase: gl.getUniformLocation(this.program, "u_starBase"),
            u_instCount: gl.getUniformLocation(this.program, "u_instCount"),
            u_tileCount: gl.getUniformLocation(this.program, "u_tileCount"),
            u_tiles: gl.getUniformLocation(this.program, "u_tiles"),
            u_sampleBase: gl.getUniformLocation(this.program, "u_sampleBase"),
            u_sampleAlpha: gl.getUniformLocation(this.program, "u_sampleAlpha"),
            u_sampleStreak: gl.getUniformLocation(this.program, "u_sampleStreak"),

            u_resolution: gl.getUniformLocation(this.program, "u_resolution"),
            u_center: gl.getUniformLocation(this.program, "u_center"),
            u_cameraXY: gl.getUniformLocation(this.program, "u_cameraXY"),
            u_parallax: gl.getUniformLocation(this.program, "u_parallax"),
            u_worldScale: gl.getUniformLocation(this.program, "u_worldScale"),
            u_virtualSize: gl.getUniformLocation(this.program, "u_virtualSize"),
            u_atlasSize: gl.getUniformLocation(this.program, "u_atlasSize"),
            u_isBlackHole: gl.getUniformLocation(this.program, "u_isBlackHole"),
            u_texture: gl.getUniformLocation(this.program, "u_texture"),
            u_time: gl.getUniformLocation(this.program, "u_time"),
            u_twinkle: gl.getUniformLocation(this.program, "u_twinkle"),
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
        // Star records are NOT vertex attributes — see STAR_DATA_TEX_W.
        gl.bindVertexArray(null);

        // GPU foreground layer (spriteBatch.js): PlayingState emits the bottom
        // of its painter stack into this batch between the starfield and the
        // blit. Optional — a failure here just leaves the Canvas path.
        this.spriteBatch = null;
        try {
            this.spriteBatch = new SpriteBatch(gl);
        } catch (e) {
            console.warn('[World] sprite batch unavailable, foreground stays on Canvas:', e);
        }
    }

    _initLayers() {
        if(!this.gl) return; // Fallback handled outside
        this.layers = []; // (re)built from scratch — also on context restore
        // Per-draw scratch (allocated once; uploaded with the *v uniform calls)
        if (!this._tileScratch) {
            this._tileScratch = new Int32Array(MAX_TILES_PER_DRAW * 2);
            this._sampleAlpha = new Float32Array(BOOST_SAMPLES);
            this._sampleStreak = new Float32Array(BOOST_SAMPLES * 2);
            this._visK = [];
            this._visM = [];
        }

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

            // Shuffle the ordinary stars so a runtime count-cap (starCull)
            // hides a scattered random subset instead of a generation-ordered
            // block. Additive blending makes draw order invisible, and the
            // shuffle rng is independent of the placement rng so existing
            // worlds keep their exact layouts.
            const shuffleRng = mulberry32((this.seed ^ 0x9e3779b9) + idx);
            for (let i = starsLighter.length - 1; i > 0; i--) {
                const j = Math.floor(shuffleRng() * (i + 1));
                [starsLighter[i], starsLighter[j]] = [starsLighter[j], starsLighter[i]];
            }

            // Convert lists to TypedArrays
            const packBatch = (list, blendMode, isBh) => {
                const buffer = new Float32Array(list.length * 10);
                let off = 0;
                // Largest half-extent (world units) any sprite in this batch
                // can reach from its center at any rotation: |w cos| + |h sin|
                // over 2 is at most (w + h) / 2. Drives wrap-tile rejection.
                let maxExtent = 0;
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
                    const ext = (uvInfo.w + uvInfo.h) / 2;
                    if (ext > maxExtent) maxExtent = ext;
                });
                return { count: list.length, buffer, blendMode, isBlackHole: isBh, maxExtent, starBase: 0 };
            };

            const batches = [];
            if (starsSourceOver.length) batches.push(packBatch(starsSourceOver, 'source-over', true));
            if (starsLighter.length) {
                const b = packBatch(starsLighter, 'lighter', false);
                b.cullable = true; // ordinary stars — subject to starCull
                batches.push(b);
            }
            if (starsScreen.length) batches.push(packBatch(starsScreen, 'screen', false));

            this.layers.push({
                parallax: config.parallax,
                alpha: config.alpha,
                batches: batches
            });
        });

        this._uploadStarData();
    }

    // Pack every batch's star records into one RGBA32F texture (3 texels per
    // star, row-major over STAR_DATA_TEX_W) and remember each batch's first
    // texel index. Values are the same float32s the old instance VBOs held.
    _uploadStarData() {
        const gl = this.gl;
        let totalStars = 0;
        for (const layer of this.layers) {
            for (const b of layer.batches) {
                b.starBase = totalStars;
                totalStars += b.count;
            }
        }
        const texels = Math.max(1, totalStars * STAR_TEXELS_PER_STAR);
        const rows = Math.ceil(texels / STAR_DATA_TEX_W);
        const data = new Float32Array(STAR_DATA_TEX_W * rows * 4);
        for (const layer of this.layers) {
            for (const b of layer.batches) {
                const src = b.buffer;
                let dst = b.starBase * STAR_TEXELS_PER_STAR * 4;
                for (let i = 0, off = 0; i < b.count; i++, off += 10) {
                    // texel 0: offset.xy, uv.xy
                    data[dst++] = src[off];     data[dst++] = src[off + 1];
                    data[dst++] = src[off + 2]; data[dst++] = src[off + 3];
                    // texel 1: uv size, sprite size
                    data[dst++] = src[off + 4]; data[dst++] = src[off + 5];
                    data[dst++] = src[off + 6]; data[dst++] = src[off + 7];
                    // texel 2: alphaBoost, rotation, (pad)
                    data[dst++] = src[off + 8]; data[dst++] = src[off + 9];
                    data[dst++] = 0;            data[dst++] = 0;
                }
            }
        }
        this.starDataRows = rows;
        if (!this.starDataTex) this.starDataTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.starDataTex);
        // Raw float records: no premultiply during this upload (the atlas
        // upload wants it on; restore afterwards).
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, STAR_DATA_TEX_W, rows, 0, gl.RGBA, gl.FLOAT, data);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Wrap-tile indices along one axis whose copies could touch the pane.
    // A star's base screen coordinate for tile k is c + (relX + k*V)*ws with
    // relX in [-V/2, V/2] (plus mod() slack), then the streak offset and the
    // sprite's own extent. Tiles whose whole reach misses [lo, hi] draw
    // nothing after clipping, so skipping them changes no pixel.
    static _visibleTileAxis(range, center, V, ws, lo, hi, reach, out) {
        out.length = 0;
        const half = (V / 2 + TILE_REJECT_SLACK_WORLD) * ws + reach;
        for (let k = -range; k <= range; k++) {
            const base = center + k * V * ws;
            if (base + half < lo || base - half > hi) continue;
            out.push(k);
        }
        return out;
    }

    // Render every non-overlapping split-screen background before the foreground
    // layers. This takes one WebGL -> Canvas snapshot instead of one per pane;
    // foreground compositing still happens on the original Canvas, in order.
    // `layerFn(batch, camera, view)` (optional) draws a GPU foreground layer
    // over each pane's starfield before the blit (see spriteBatch.js); its
    // return value is stored on `view.gpuLayer` (false = the caller must draw
    // that layer on Canvas).
    drawViews(ctx, views, worldTime = 0, layerFn = null) {
        if (!this.gl || this._glContextLost || this.gl.isContextLost()) return false;
        const cw = ctx.canvas.width, ch = ctx.canvas.height;
        if (this.glCanvas.width !== cw || this.glCanvas.height !== ch) {
            this.glCanvas.width = cw; this.glCanvas.height = ch;
            this.gl.viewport(0, 0, cw, ch);
        }
        // Layouts with 3/5/7 pilots leave unused cells. Never retain stars there
        // from an earlier layout or frame (also works between synchronous draws).
        this.gl.disable(this.gl.SCISSOR_TEST);
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        for (const v of views) {
            if (!this._renderBackground(cw, ch, v.camera, v.player, worldTime, v.camera.scale)) return false;
            v.gpuLayer = (layerFn && this.spriteBatch) ? layerFn(this.spriteBatch, v.camera, v) : false;
        }
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.drawImage(this.glCanvas, 0, 0);
        ctx.restore();
        return true;
    }

    // Returns the GPU layer result (true = drawn, false = not drawn) when
    // `layerFn` is given and the background was rendered here; else undefined.
    draw(ctx, camera, player, worldTime = 0, backgroundDrawn = false, layerFn = null) {
        let layerResult;
        if (!backgroundDrawn) {
            if (!this._renderBackground(ctx.canvas.width, ctx.canvas.height, camera, player, worldTime)) return false;
            layerResult = (layerFn && this.spriteBatch) ? layerFn(this.spriteBatch, camera, null) : false;
            const vp = camera.viewport;
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            if (vp) ctx.drawImage(this.glCanvas, vp.x, vp.y, vp.w, vp.h, vp.x, vp.y, vp.w, vp.h);
            else ctx.drawImage(this.glCanvas, 0, 0);
            ctx.restore();
        }
        // Shops stay in their original per-pane position in the painter order.
        if (this.game.currentState.shops) {
            for (const shop of this.game.currentState.shops) shop.draw(ctx, camera);
        }
        return layerResult;
    }

    _renderBackground(cw, ch, camera, player, worldTime = 0, worldScale = this.game.worldScale) {
        if (!this.gl || this._glContextLost || this.gl.isContextLost()) return false;
        
        const boostIntensity = player ? player.boostIntensity : 0;
        const isBoosting = boostIntensity > 0.01;
        const streakFactor = 0.04;

        if (this.glCanvas.width !== cw || this.glCanvas.height !== ch) {
            this.glCanvas.width = cw;
            this.glCanvas.height = ch;
            this.gl.viewport(0, 0, cw, ch);
        }

        // Split-screen: render only this pane's rect. A camera with no viewport
        // (single-view default) covers the whole canvas — byte-identical path.
        const vp = camera.viewport || { x: 0, y: 0, w: cw, h: ch };
        const centerX = vp.x + vp.w / 2;
        const centerY = vp.y + vp.h / 2;

        const gl = this.gl;
        // Scissor to the pane so the clear + draws only touch its region of the
        // scratch canvas (leaving other panes' freshly-blitted pixels intact).
        // GL scissor origin is bottom-left, so flip Y. Full-canvas scissor is a
        // no-op vs the original full clear.
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(vp.x, ch - (vp.y + vp.h), vp.w, vp.h);
        gl.clearColor(0, 0, 0, 0); // fully transparent backing
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);
        gl.bindVertexArray(this.quadVao);

        gl.uniform2f(this.locs.u_resolution, cw, ch);
        gl.uniform2f(this.locs.u_center, centerX, centerY);
        gl.uniform2f(this.locs.u_cameraXY, camera.x, camera.y);
        gl.uniform1f(this.locs.u_worldScale, worldScale);
        gl.uniform1f(this.locs.u_virtualSize, this.virtualSize);
        gl.uniform2f(this.locs.u_atlasSize, this.atlasWidth, this.atlasHeight);

        const viewW = vp.w / worldScale;
        const viewH = vp.h / worldScale;
        const rangeX = Math.ceil(viewW / this.virtualSize / 2) + 1;
        const rangeY = Math.ceil(viewH / this.virtualSize / 2) + 1;

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.starDataTex);
        gl.uniform1i(this.locs.u_starData, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(this.locs.u_texture, 0);
        gl.uniform1f(this.locs.u_time, worldTime);
        gl.uniform1f(this.locs.u_twinkle, 0.65);

        // Effective ordinary-star cull: story cull (dragon) OR the settings
        // baseline, whichever hides more. Rare objects are never culled.
        const effStarCull = Math.max(this.starCull,
            SETTINGS.reducedParticles ? REDUCED_PARTICLES_STAR_CULL : 0);

        const samples = isBoosting ? BOOST_SAMPLES : 1;
        const sampleAlpha = this._sampleAlpha;
        const sampleStreak = this._sampleStreak;
        const tiles = this._tileScratch;
        const visK = this._visK, visM = this._visM;
        const paneX0 = vp.x, paneX1 = vp.x + vp.w;
        const paneY0 = vp.y, paneY1 = vp.y + vp.h;

        for (const layer of this.layers) {
            const layerAlpha = layer.alpha * (0.95 + 0.05 * Math.sin(worldTime * (1 + layer.parallax * 2)));
            gl.uniform1f(this.locs.u_parallax, layer.parallax);

            const svx = player ? -player.vx * layer.parallax * streakFactor * boostIntensity * worldScale : 0;
            const svy = player ? -player.vy * layer.parallax * streakFactor * boostIntensity * worldScale : 0;
            // Per-sample streak offsets are the same for every batch in the
            // layer (|offsetMult| < 1, so |svx|/|svy| bound the streak reach).
            for (let s = 0; s < samples; s++) {
                const offsetMult = samples > 1 ? (s / samples) : 0;
                sampleStreak[s * 2] = svx * offsetMult;
                sampleStreak[s * 2 + 1] = svy * offsetMult;
            }
            gl.uniform2fv(this.locs.u_sampleStreak, sampleStreak);
            const streakReachX = Math.abs(svx), streakReachY = Math.abs(svy);

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

                // starCull hides the tail of the (pre-shuffled) star list.
                const instCount = (batch.cullable && effStarCull > 0)
                    ? Math.max(0, Math.round(batch.count * (1 - effStarCull)))
                    : batch.count;
                if (instCount <= 0) continue;

                // Per-sample global alpha — the same arithmetic the old loop
                // uploaded one uniform at a time. Additive batches skip samples
                // whose weight is zero (s = 0 and s = 7: sin(0), sin(pi)):
                // texColor * ~1e-17 quantizes to 0 and ONE/ONE adds nothing,
                // so the pixels are identical. Black holes are source-over and
                // ignore alpha, so every sample of theirs is kept.
                let s0 = samples, s1 = 0;
                for (let s = 0; s < samples; s++) {
                    const t = samples > 1 ? s / (samples - 1) : 0.5;
                    const weight = samples > 1 ? Math.sin(t * Math.PI) : 1.0;
                    const boostComp = samples > 1 ? (1.8 / samples) : 1.0;
                    const finalAlpha = batch.isBlackHole ? 1.0 : (layerAlpha * weight * boostComp);
                    sampleAlpha[s] = finalAlpha;
                    if (batch.isBlackHole || finalAlpha > 1e-9) {
                        if (s < s0) s0 = s;
                        s1 = s + 1;
                    }
                }
                if (s1 <= s0) continue;
                gl.uniform1fv(this.locs.u_sampleAlpha, sampleAlpha);

                // Wrap tiles whose copies can reach this pane (see
                // _visibleTileAxis). Rejecting a whole tile skips its vertex
                // work without touching any pixel that would have been drawn.
                const reachX = batch.maxExtent * worldScale + streakReachX + 2;
                const reachY = batch.maxExtent * worldScale + streakReachY + 2;
                World._visibleTileAxis(rangeX, centerX, this.virtualSize, worldScale, paneX0, paneX1, reachX, visK);
                World._visibleTileAxis(rangeY, centerY, this.virtualSize, worldScale, paneY0, paneY1, reachY, visM);
                const tileCount = visK.length * visM.length;
                if (tileCount === 0) continue;

                gl.uniform1i(this.locs.u_starBase, batch.starBase);
                gl.uniform1i(this.locs.u_instCount, instCount);

                if (tileCount <= MAX_TILES_PER_DRAW) {
                    // ONE draw for every sample x tile x star copy of the batch,
                    // in k-outer / m-inner tile order like the old loops.
                    let n = 0;
                    for (let ki = 0; ki < visK.length; ki++) {
                        for (let mi = 0; mi < visM.length; mi++) {
                            tiles[n++] = visK[ki];
                            tiles[n++] = visM[mi];
                        }
                    }
                    gl.uniform2iv(this.locs.u_tiles, tiles);
                    gl.uniform1i(this.locs.u_tileCount, tileCount);
                    gl.uniform1i(this.locs.u_sampleBase, s0);
                    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, (s1 - s0) * tileCount * instCount);
                } else {
                    // Absurd FOV: more tiles than one draw addresses. Keep the
                    // sample -> tile order by chunking tiles inside each sample.
                    for (let s = s0; s < s1; s++) {
                        gl.uniform1i(this.locs.u_sampleBase, s);
                        let n = 0;
                        const flush = () => {
                            const cnt = n >> 1;
                            gl.uniform2iv(this.locs.u_tiles, tiles);
                            gl.uniform1i(this.locs.u_tileCount, cnt);
                            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cnt * instCount);
                            n = 0;
                        };
                        for (let ki = 0; ki < visK.length; ki++) {
                            for (let mi = 0; mi < visM.length; mi++) {
                                tiles[n++] = visK[ki];
                                tiles[n++] = visM[mi];
                                if (n === tiles.length) flush();
                            }
                        }
                        if (n > 0) flush();
                    }
                }
            }
        }

        // Unbind VAO purely for safety
        gl.bindVertexArray(null);
        gl.disable(gl.SCISSOR_TEST);

        return true;
    }
}
