// Instanced sprite batch inside the starfield's WebGL2 context — the
// perf-audit-2 ticket 9 prototype ("shared GPU scene renderer").
//
// The scene composite stays on Canvas 2D: World renders the starfield into its
// scratch glCanvas, PlayingState emits the BOTTOM of the painter stack
// (sector tint + dust, rubble, debris, scrap, pickups, exp orbs) into this
// batch in the exact order the Canvas loops drew them, the batch draws them
// over the starfield with matching blend functions, and the existing single
// blit puts starfield + layer into the game canvas. Everything above stays on
// Canvas, so painter order and every `screen`/`lighter` blend against the
// starfield are preserved. (Layering the GL canvas under the game canvas in
// the DOM would have removed the blit but broken those blends — additive
// foreground drawn onto a transparent canvas no longer sees the stars.)
//
// Textures: sprites are the SAME 4x prescaled canvases Canvas 2D draws, packed
// on first sight into a runtime atlas (keyed by canvas identity — sources must
// be immutable, which every consumer here honours: atlas frames, cached glow
// canvases, cached voronoi fragments / chip cells). Sampling clamps to the
// sprite rect (clamp-to-edge like drawImage), kind 1 snaps to texel centers
// for imageSmoothingEnabled=false, and quad edges get analytic coverage AA
// like Skia's image edges. Output is premultiplied; blend groups map to
// Canvas ops: source-over ONE/ONE_MINUS_SRC_ALPHA, lighter ONE/ONE, screen
// ONE/ONE_MINUS_SRC_COLOR. Near-identical, not byte-identical — verified by
// scripts/perf/scene_diff.mjs with a tolerance.
//
// Failure modes fall back, never mis-draw: a sprite that can't be packed
// (atlas full even after compacting stale entries, or larger than the atlas)
// marks the batch `failed`; the caller discards the batch and draws the layer
// on Canvas as before.

export const BLEND_SRC_OVER = 0;
export const BLEND_LIGHTER = 1;
export const BLEND_SCREEN = 2;

export const KIND_SPRITE = 0;          // textured, bilinear (imageSmoothingEnabled)
export const KIND_SPRITE_NEAREST = 1;  // textured, nearest (imageSmoothingEnabled=false)
export const KIND_RING = 2;            // stroked circle (params: radius, half line width)
export const KIND_RECT = 3;            // solid color quad (fillRect / butt-capped line)

const FLOATS = 16;                     // per instance, see layout in _emit
const ATLAS_SIZE = 2048;
const ATLAS_PAD = 1;                   // transparent gutter around every entry
const ATLAS_STALE_MS = 10000;          // compact() drops entries unused this long
const INITIAL_CAPACITY = 2048;

const VS = `#version 300 es
in vec2 a_pos;
in vec4 a_rect;       // cx, cy, w, h  (screen px, top-down)
in vec2 a_rotAlpha;   // rotation (rad), alpha
in vec4 a_uv;         // u0, v0, u1, v1
in vec4 a_kindColor;  // kind, r, g, b
in vec2 a_params;     // ring: radius px, half line width px
uniform vec2 u_resolution;
out vec2 v_uv;
out vec2 v_local;
flat out vec4 v_uvRect;
flat out vec4 v_kindColor;
flat out vec2 v_params;
flat out vec2 v_size;
flat out float v_alpha;
void main() {
    float c = cos(a_rotAlpha.x), s = sin(a_rotAlpha.x);
    vec2 p = a_pos * a_rect.zw;
    vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    vec2 screen = a_rect.xy + r;
    vec2 clip = screen / u_resolution * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    v_uv = a_pos + 0.5;
    v_local = p;
    v_uvRect = a_uv;
    v_kindColor = a_kindColor;
    v_params = a_params;
    v_size = a_rect.zw;
    v_alpha = a_rotAlpha.y;
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform vec2 u_atlasSize;
in vec2 v_uv;
in vec2 v_local;
flat in vec4 v_uvRect;
flat in vec4 v_kindColor;
flat in vec2 v_params;
flat in vec2 v_size;
flat in float v_alpha;
out vec4 outColor;
void main() {
    // Analytic edge coverage of the quad (Skia anti-aliases image/rect edges).
    vec2 d = v_size * 0.5 - abs(v_local);
    float cov = clamp(d.x + 0.5, 0.0, 1.0) * clamp(d.y + 0.5, 0.0, 1.0);
    int kind = int(v_kindColor.x + 0.5);
    vec4 col;
    if (kind <= 1) {
        vec2 uv = v_uvRect.xy + v_uv * (v_uvRect.zw - v_uvRect.xy);
        vec2 texel = uv * u_atlasSize;
        if (kind == 1) texel = floor(texel) + 0.5;
        vec2 lo = v_uvRect.xy * u_atlasSize + 0.5;
        vec2 hi = v_uvRect.zw * u_atlasSize - 0.5;
        texel = clamp(texel, lo, hi);
        col = texture(u_atlas, texel / u_atlasSize); // premultiplied
    } else if (kind == 2) {
        float dist = abs(length(v_local) - v_params.x);
        float a = clamp(v_params.y - dist + 0.5, 0.0, 1.0);
        col = vec4(v_kindColor.yzw, 1.0) * a;
        cov = 1.0;
    } else {
        col = vec4(v_kindColor.yzw, 1.0);
    }
    outColor = col * (v_alpha * cov);
}`;

export class SpriteBatch {
    constructor(gl) {
        this.gl = gl;
        this.failed = false;       // set while emitting when a sprite can't be packed
        this.count = 0;
        this.capacity = INITIAL_CAPACITY;
        this.data = new Float32Array(this.capacity * FLOATS);
        this.blends = new Uint8Array(this.capacity);
        this._now = 0;
        this._scissor = null;
        this._resW = 0; this._resH = 0;
        this.stats = { draws: 0, instances: 0, uploads: 0, compactions: 0 };
        this._initGL();
        this._initAtlas();
    }

    _initGL() {
        const gl = this.gl;
        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        this.program = prog;
        this.locs = {
            a_pos: gl.getAttribLocation(prog, 'a_pos'),
            a_rect: gl.getAttribLocation(prog, 'a_rect'),
            a_rotAlpha: gl.getAttribLocation(prog, 'a_rotAlpha'),
            a_uv: gl.getAttribLocation(prog, 'a_uv'),
            a_kindColor: gl.getAttribLocation(prog, 'a_kindColor'),
            a_params: gl.getAttribLocation(prog, 'a_params'),
            u_resolution: gl.getUniformLocation(prog, 'u_resolution'),
            u_atlas: gl.getUniformLocation(prog, 'u_atlas'),
            u_atlasSize: gl.getUniformLocation(prog, 'u_atlasSize'),
        };
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
            -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.locs.a_pos);
        gl.vertexAttribPointer(this.locs.a_pos, 2, gl.FLOAT, false, 0, 0);
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
        const stride = FLOATS * 4;
        const attr = (loc, size, off) => {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
            gl.vertexAttribDivisor(loc, 1);
        };
        attr(this.locs.a_rect, 4, 0);
        attr(this.locs.a_rotAlpha, 2, 4);
        attr(this.locs.a_uv, 4, 6);
        attr(this.locs.a_kindColor, 4, 10);
        attr(this.locs.a_params, 2, 14);
        gl.bindVertexArray(null);
    }

    _initAtlas() {
        const gl = this.gl;
        this.atlasSize = ATLAS_SIZE;
        this.atlas = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.atlas);
        // Zero-initialized: every gutter is transparent.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_SIZE, ATLAS_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.entries = new Map();   // canvas -> { x, y, w, h, u0, v0, u1, v1, lastUse }
        this._shelves = [];         // { y, h, x }
        this._shelfTop = 0;
    }

    // ── Atlas packing ─────────────────────────────────────────────────────
    _place(w, h) {
        const pw = w + ATLAS_PAD * 2, ph = h + ATLAS_PAD * 2;
        if (pw > this.atlasSize || ph > this.atlasSize) return null;
        for (const s of this._shelves) {
            if (ph <= s.h && s.x + pw <= this.atlasSize) {
                const r = { x: s.x + ATLAS_PAD, y: s.y + ATLAS_PAD };
                s.x += pw;
                return r;
            }
        }
        if (this._shelfTop + ph > this.atlasSize) return null;
        const shelf = { y: this._shelfTop, h: ph, x: pw };
        this._shelves.push(shelf);
        this._shelfTop += ph;
        return { x: ATLAS_PAD, y: shelf.y + ATLAS_PAD };
    }

    _upload(canvas, x, y) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.atlas);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.stats.uploads++;
    }

    // Rebuild the atlas keeping only recently used entries (a full atlas is
    // normally stale chip-cell / fragment canvases from long ago).
    compact() {
        const gl = this.gl;
        const keep = [];
        for (const [canvas, e] of this.entries) {
            if (this._now - e.lastUse <= ATLAS_STALE_MS && canvas.width > 0 && canvas.height > 0) keep.push([canvas, e]);
        }
        keep.sort((a, b) => b[1].h - a[1].h);
        this.entries = new Map();
        this._shelves = [];
        this._shelfTop = 0;
        gl.bindTexture(gl.TEXTURE_2D, this.atlas);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.atlasSize, this.atlasSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        for (const [canvas, e] of keep) {
            const p = this._place(e.w, e.h);
            if (!p) continue; // drops the entry; re-added on next sight if there's room
            this._register(canvas, p.x, p.y, e.w, e.h, e.lastUse);
        }
        this.stats.compactions++;
    }

    _register(canvas, x, y, w, h, lastUse) {
        const n = this.atlasSize;
        const e = { x, y, w, h, u0: x / n, v0: y / n, u1: (x + w) / n, v1: (y + h) / n, lastUse };
        this.entries.set(canvas, e);
        this._upload(canvas, x, y);
        return e;
    }

    entryFor(canvas) {
        let e = this.entries.get(canvas);
        if (e) { e.lastUse = this._now; return e; }
        const w = canvas.width, h = canvas.height;
        if (!(w > 0 && h > 0)) return null;
        let p = this._place(w, h);
        if (!p) {
            this.compact();
            p = this._place(w, h);
            if (!p) return null;
        }
        return this._register(canvas, p.x, p.y, w, h, this._now);
    }

    // ── Emission ──────────────────────────────────────────────────────────
    begin(resW, resH, scissor, nowMs) {
        this.count = 0;
        this.failed = false;
        this._resW = resW; this._resH = resH;
        this._scissor = scissor || null;
        this._now = nowMs !== undefined ? nowMs : this._now + 16;
    }

    discard() { this.count = 0; this.failed = false; }

    _grow() {
        this.capacity *= 2;
        const d = new Float32Array(this.capacity * FLOATS);
        d.set(this.data);
        this.data = d;
        const b = new Uint8Array(this.capacity);
        b.set(this.blends);
        this.blends = b;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    }

    _emit(cx, cy, w, h, rot, alpha, u0, v0, u1, v1, kind, r, g, b, p0, p1, blend) {
        if (this.count >= this.capacity) this._grow();
        const o = this.count * FLOATS, d = this.data;
        d[o] = cx; d[o + 1] = cy; d[o + 2] = w; d[o + 3] = h;
        d[o + 4] = rot; d[o + 5] = alpha;
        d[o + 6] = u0; d[o + 7] = v0; d[o + 8] = u1; d[o + 9] = v1;
        d[o + 10] = kind; d[o + 11] = r; d[o + 12] = g; d[o + 13] = b;
        d[o + 14] = p0; d[o + 15] = p1;
        this.blends[this.count++] = blend;
    }

    // drawImage(canvas, cx - w/2, cy - h/2, w, h) under rotate(rot) at (cx, cy),
    // globalAlpha alpha. `nearest` mirrors imageSmoothingEnabled = false.
    sprite(canvas, cx, cy, w, h, rot, alpha, blend, nearest) {
        const e = this.entryFor(canvas);
        if (!e) { this.failed = true; return false; }
        this._emit(cx, cy, w, h, rot, alpha, e.u0, e.v0, e.u1, e.v1,
            nearest ? KIND_SPRITE_NEAREST : KIND_SPRITE, 1, 1, 1, 0, 0, blend);
        return true;
    }

    // fillRect / butt-capped line as a rotated solid quad. r,g,b in 0..1.
    rect(cx, cy, w, h, rot, r, g, b, alpha, blend) {
        this._emit(cx, cy, w, h, rot, alpha, 0, 0, 0, 0, KIND_RECT, r, g, b, 0, 0, blend);
    }

    // stroke(arc(cx, cy, radius)) with lineWidth = 2 * halfWidth.
    ring(cx, cy, radius, halfWidth, r, g, b, alpha, blend) {
        const s = (radius + halfWidth + 1) * 2;
        this._emit(cx, cy, s, s, 0, alpha, 0, 0, 0, 0, KIND_RING, r, g, b, radius, halfWidth, blend);
    }

    flush() {
        const n = this.count;
        if (!n || this.failed) { this.count = 0; return; }
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, n * FLOATS));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.atlas);
        gl.uniform1i(this.locs.u_atlas, 0);
        gl.uniform2f(this.locs.u_resolution, this._resW, this._resH);
        gl.uniform2f(this.locs.u_atlasSize, this.atlasSize, this.atlasSize);
        if (this._scissor) {
            const s = this._scissor;
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(s.x, this._resH - (s.y + s.h), s.w, s.h);
        } else {
            gl.disable(gl.SCISSOR_TEST);
        }
        gl.enable(gl.BLEND);
        let start = 0;
        while (start < n) {
            const blend = this.blends[start];
            let end = start + 1;
            while (end < n && this.blends[end] === blend) end++;
            if (blend === BLEND_LIGHTER) gl.blendFunc(gl.ONE, gl.ONE);
            else if (blend === BLEND_SCREEN) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
            else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            // Instance offset via base instance isn't available in WebGL2; use
            // the attribute pointers' offset instead (re-point per run).
            this._pointTo(start);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, end - start);
            this.stats.draws++;
            this.stats.instances += end - start;
            start = end;
        }
        if (n > 1) this._pointTo(0);
        gl.disable(gl.SCISSOR_TEST);
        gl.bindVertexArray(null);
        this.count = 0;
    }

    _pointTo(instance) {
        const gl = this.gl;
        const stride = FLOATS * 4, base = instance * stride;
        gl.vertexAttribPointer(this.locs.a_rect, 4, gl.FLOAT, false, stride, base);
        gl.vertexAttribPointer(this.locs.a_rotAlpha, 2, gl.FLOAT, false, stride, base + 16);
        gl.vertexAttribPointer(this.locs.a_uv, 4, gl.FLOAT, false, stride, base + 24);
        gl.vertexAttribPointer(this.locs.a_kindColor, 4, gl.FLOAT, false, stride, base + 40);
        gl.vertexAttribPointer(this.locs.a_params, 2, gl.FLOAT, false, stride, base + 56);
    }

    destroy() {
        const gl = this.gl;
        if (this.atlas) gl.deleteTexture(this.atlas);
        if (this.vbo) gl.deleteBuffer(this.vbo);
        if (this.program) gl.deleteProgram(this.program);
        this.atlas = null; this.vbo = null; this.program = null;
        this.entries = new Map();
    }
}
