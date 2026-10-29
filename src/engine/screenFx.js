import { effectIsActive, effectBounds, unionRect, mergeUploadRects } from './screenFxBounds.js';

// Full-screen CRT-style post-processing (chromatic aberration, vignette,
// barrel distortion) driven by an intensity value 0..1 — used by the
// kill-streak escalation (and later, story-dread effects).
//
// The game renders on Canvas2D. This uploads only texels the unchanged shader
// can sample and draws affected regions on a transparent WebGL2 overlay. Exact
// identity regions expose the original Canvas; globally supported effects keep
// their full pane. The full-resolution texture and filtering are unchanged.
// Idle frames skip the upload/pass entirely; unavailable WebGL2 is a no-op.

const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;          // full canvas size (px) — texture is the whole canvas
uniform vec2 u_paneOrigin;   // this pane's origin (px, gl bottom-up); (0,0) = fullscreen
uniform vec2 u_paneSize;     // this pane's size (px); == u_res when fullscreen
uniform float u_crt;    // kill-streak CRT look (barrel/chroma/vignette)
uniform float u_warp;   // dread insanity pulse (wobble/tear/desaturate)
uniform vec4 u_ripple;  // shield impact: xy = impact point (px), z = bubble radius (px), w = strength
uniform vec2 u_rippleCenter; // bubble center (px) for the area mask
uniform float u_rippleT;     // seconds since impact
uniform vec4 u_flow;     // boost: xy = ship (px), zw = travel dir * strength
uniform vec4 u_collapse; // teleport: xy = ship (px), z = radius (px), w = strength
uniform float u_collapseAb; // collapse chromatic-aberration multiplier (0 = warp only, no fringing)
uniform float u_time;
out vec4 outColor;

void main() {
    // Work in PANE-local normalized space so the barrel/vignette center on each
    // pane (split-screen) and every pane behaves like its own screen. Sampling
    // maps the displaced pane-local uv back to the full-canvas texture below.
    vec2 local = gl_FragCoord.xy - u_paneOrigin;
    vec2 uv = local / u_paneSize;
    vec2 c = uv - 0.5;
    float aspect = u_paneSize.x / u_paneSize.y;
    vec2 ca = c * vec2(aspect, 1.0);
    float r2 = dot(ca, ca) / (0.25 * aspect * aspect + 0.25); // ~0..1 at corners

    // ── Kill-streak CRT: barrel bulge, breathing very slightly with time ──
    float k = 0.085 * u_crt * (1.0 + 0.06 * sin(u_time * 2.7));
    vec2 duv = c * (1.0 + k * r2);
    duv *= 1.0 - k * 0.6; // zoom in a touch so the bent edges stay on screen

    // ── Dread warp: the picture itself stops being trustworthy ──
    if (u_warp > 0.001) {
        // Two octaves of slow liquid wobble — broad swells with a faint
        // ripple riding them, like the image is underwater
        duv.x += (sin((duv.y + 0.5) * 9.0 + u_time * 1.8) * 0.006
                + sin((duv.y + 0.5) * 23.0 - u_time * 3.1) * 0.002) * u_warp;
        duv.y += (sin((duv.x + 0.5) * 7.0 - u_time * 1.3) * 0.005
                + sin((duv.x + 0.5) * 19.0 + u_time * 2.6) * 0.0015) * u_warp;
        // Occasional gentle slip of a horizontal band — rare and small
        float band = floor((duv.y + 0.5) * 16.0);
        float h = fract(sin(band * 91.7 + floor(u_time * 12.0) * 7.31) * 43758.5453);
        if (h > 1.0 - 0.10 * u_warp) {
            duv.x += (fract(h * 13.7) - 0.5) * 0.03 * u_warp;
        }
    }

    // ── Shield ripple: a displacement wave radiating across the bubble from
    // the exact impact point, masked to the shield's area ──
    if (u_ripple.w > 0.001) {
        vec2 frag = gl_FragCoord.xy;
        float dImpact = distance(frag, u_ripple.xy);
        // Traveling wavefront expanding from the hit
        float front = u_rippleT * (u_ripple.z * 7.0);
        float band = exp(-pow((dImpact - front) / (u_ripple.z * 0.16), 2.0));
        // Confine the distortion to the bubble (soft edge)
        float dCenter = distance(frag, u_rippleCenter);
        float mask = 1.0 - smoothstep(u_ripple.z * 0.95, u_ripple.z * 1.2, dCenter);
        vec2 dir = dImpact > 0.5 ? (frag - u_ripple.xy) / dImpact : vec2(0.0);
        duv += dir * (band * mask * u_ripple.w * 5.0) / u_paneSize;
    }

    // ── Boost flow: space bends around the hull along the line of travel ──
    float flowStr = length(u_flow.zw);
    if (flowStr > 0.001) {
        vec2 d = gl_FragCoord.xy - u_flow.xy;
        vec2 fdir = u_flow.zw / flowStr;
        float R = 0.30 * min(u_paneSize.x, u_paneSize.y);
        float fall = exp(-dot(d, d) / (R * R));
        vec2 fperp = vec2(-fdir.y, fdir.x);
        // Space contracts toward the ship along the travel axis — compressed
        // ahead of the nose, stretched out behind it (a uniform shift reads
        // as nothing at speed; the variation across the screen is the bend)
        float along = dot(d, fdir);
        duv += fdir * along * fall * flowStr * 0.22 / u_paneSize;
        // ...dragged back past the hull...
        duv += fdir * (fall * flowStr * R * 0.13) / u_paneSize;
        // ...and pinched in toward the line of travel
        duv += fperp * dot(d, fperp) * fall * flowStr * 0.22 / u_paneSize;
    }

    // ── Teleport collapse: space falls inward toward the ship ──
    if (u_collapse.w > 0.001) {
        vec2 d = gl_FragCoord.xy - u_collapse.xy;
        float dist = max(length(d), 0.5);
        float fall = exp(-(dist * dist) / (u_collapse.z * u_collapse.z));
        // Ramp to zero at the hull itself so there's no seam on the ship,
        // peak displacement capped in absolute pixels
        float ramp = smoothstep(0.0, 0.22, dist / u_collapse.z);
        float amt = u_collapse.w * min(u_collapse.z * 0.08, 42.0);
        duv += (d / dist) * (fall * ramp * amt) / u_paneSize;
    }

    // Chromatic aberration: CRT separates at edges; warp separates everywhere;
    // boost/teleport distortion fringes a touch near full strength
    float s = 0.011 * u_crt * r2 + 0.004 * u_warp
            + 0.002 * flowStr + 0.003 * u_collapse.w * u_collapseAb;
    // The source canvas is uploaded WITHOUT UNPACK_FLIP_Y_WEBGL (that flag forces
    // a slow per-frame CPU copy for canvas texture sources in Chrome). The
    // texture is therefore stored vertically mirrored; we cancel that by flipping
    // the sample V here. Two mirrors == identity, so the sampled pixels are
    // byte-for-byte what they were before — only the upload got cheaper.
    // duv is centered PANE-local; +0.5 → pane-local uv, then map into the pane's
    // sub-rect of the full-canvas texture: (origin + paneLocal*size) / res.
    vec2 srL = duv * (1.0 + s) + 0.5;
    vec2 sgL = duv + 0.5;
    vec2 sbL = duv * (1.0 - s) + 0.5;
    vec2 sr = (u_paneOrigin + srL * u_paneSize) / u_res;
    vec2 sg = (u_paneOrigin + sgL * u_paneSize) / u_res;
    vec2 sb = (u_paneOrigin + sbL * u_paneSize) / u_res;
    vec3 col;
    col.r = texture(u_tex, vec2(sr.x, 1.0 - sr.y)).r;
    col.g = texture(u_tex, vec2(sg.x, 1.0 - sg.y)).g;
    col.b = texture(u_tex, vec2(sb.x, 1.0 - sb.y)).b;

    // CRT edge vignette — kept modest so the rarity-colored Canvas vignette
    // underneath isn't crushed to black
    float vig = 1.0 - 0.22 * u_crt * smoothstep(0.25, 1.0, r2);

    // Dread drains the color out of the world
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(luma * 0.78), 0.4 * u_warp);

    outColor = vec4(col * vig, 1.0);
}`;

export class ScreenFX {
    constructor(game) {
        this.game = game;
        this.canvas = null;
        this.gl = null;
        this._failed = false;
        this._contextLost = false;
        this._program = null;
        this._texture = null;
        this._singleEffect = [null];
        this._active = false;
        this.boundedTransfers = true; // false: full-frame reference path for A/B checks
        // Firefox snapshots the WHOLE source canvas on every canvas→texture
        // upload, even for a subrect, so a small shield ripple cost 10–28 ms a
        // frame there. Copying just the subrect into a scratch canvas first
        // (canvas→canvas stays cheap) and uploading that is ~free. Chromium
        // uploads subrects directly and fast, so it keeps the direct path.
        this.cropUploads = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
        this._crop = null;
        this._cropCtx = null;
        this.lastUploadPixels = 0;
        this.lastDrawPixels = 0;
        this._texW = 0;
        this._texH = 0;
    }

    _init() {
        try {
            const canvas = this.canvas || document.createElement('canvas');
            canvas.id = 'fxCanvas';
            canvas.style.position = 'fixed';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.pointerEvents = 'none';
            canvas.style.display = 'none';
            // premultipliedAlpha:true (the compositor's native format): every
            // overlay pixel is either the cleared (0,0,0,0) or shader output
            // with alpha 1.0, and for those premultiplied == straight, so the
            // composited result is identical — minus a per-frame conversion.
            const gl = canvas.getContext('webgl2', {
                alpha: true, depth: false, stencil: false,
                antialias: false, premultipliedAlpha: true,
                preserveDrawingBuffer: false
            });
            if (!gl) { this._failed = true; return; }
            // The game canvas is opaque (alpha:false 2D context, see game.js),
            // so premultiplied == straight for every uploaded texel and the
            // shader reads only .rgb anyway. Matching the 2D canvas's own
            // premultiplied storage lets the browser keep the canvas→texture
            // copy on its fast GPU path instead of un-premultiplying (often a
            // CPU readback). No Y flip either: the shader flips V itself.
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            if (!this.canvas) {
                this._onContextLost = e => {
                    e.preventDefault();
                    this._contextLost = true;
                    this._hide();
                };
                this._onContextRestored = () => {
                    this._contextLost = false;
                    this._texW = 0; this._texH = 0;
                    this._init();
                };
                canvas.addEventListener('webglcontextlost', this._onContextLost);
                canvas.addEventListener('webglcontextrestored', this._onContextRestored);
                document.body.appendChild(canvas);
            }

            this.canvas = canvas;
            this.gl = gl;
            const compile = (type, src) => {
                const sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                    throw new Error(gl.getShaderInfoLog(sh));
                }
                return sh;
            };
            const prog = gl.createProgram();
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                throw new Error(gl.getProgramInfoLog(prog));
            }
            for (const sh of gl.getAttachedShaders(prog)) gl.deleteShader(sh);
            gl.useProgram(prog);

            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);

            this._program = prog;
            this._texture = tex;
            this.canvas = canvas;
            this.gl = gl;
            this._uRes = gl.getUniformLocation(prog, 'u_res');
            this._uPaneOrigin = gl.getUniformLocation(prog, 'u_paneOrigin');
            this._uPaneSize = gl.getUniformLocation(prog, 'u_paneSize');
            this._uCrt = gl.getUniformLocation(prog, 'u_crt');
            this._uWarp = gl.getUniformLocation(prog, 'u_warp');
            this._uRipple = gl.getUniformLocation(prog, 'u_ripple');
            this._uRippleCenter = gl.getUniformLocation(prog, 'u_rippleCenter');
            this._uRippleT = gl.getUniformLocation(prog, 'u_rippleT');
            this._uFlow = gl.getUniformLocation(prog, 'u_flow');
            this._uCollapse = gl.getUniformLocation(prog, 'u_collapse');
            this._uCollapseAb = gl.getUniformLocation(prog, 'u_collapseAb');
            this._uTime = gl.getUniformLocation(prog, 'u_time');
        } catch (e) {
            console.error('[ScreenFX] init failed, disabling post-fx:', e);
            this._failed = true;
            this.destroy();
        }
    }

    // Build the WebGL pipeline ahead of time (called from the title-screen
    // prewarm) so the first real effect — often the first boost of a run —
    // doesn't pay the context creation + shader compile cost mid-gameplay.
    // The overlay canvas stays display:none until an effect actually renders.
    warm() {
        if (!this.gl && !this._failed) this._init();
    }

    // fx: { crt, warp, ripple?: {x, y, cx, cy, r, strength, t},
    //       flow?: {x, y, dirX, dirY, strength},          — boost space-bend
    //       collapse?: {x, y, r, strength} }              — teleport implosion
    // — the pass is skipped entirely when everything is (effectively) zero.
    // `intensity` (0..1, the settings distortion dial) scales every knob at
    // uniform-upload time so caller descriptors are never mutated.
    render(fx, time, intensity = 1) {
        this._singleEffect[0] = fx;
        this._renderEffects(this._singleEffect, time, intensity, false);
    }

    renderPanes(panes, time, intensity = 1) {
        this._renderEffects(panes, time, intensity, true);
    }

    _hide() {
        if (this._active && this.canvas) this.canvas.style.display = 'none';
        this._active = false;
        this.lastUploadPixels = 0;
        this.lastUploadRects = 0;
        this.lastDrawPixels = 0;
    }

    _renderEffects(effects, time, intensity, split) {
        if (this._failed || this._contextLost) return;
        this._intensity = intensity;
        if (!effects.some(fx => effectIsActive(fx, intensity))) { this._hide(); return; }
        if (!this.gl) { this._init(); if (this._failed) return; }
        const src = this.game.canvas, gl = this.gl;
        const w = src.width, h = src.height;
        if (!w || !h) { this._hide(); return; }
        const whole = { x: 0, y: 0, w, h };
        const regions = [];
        const sources = [];
        for (const fx of effects) {
            const pane = split ? fx.rect : whole;
            const bounds = this.boundedTransfers
                ? effectBounds(fx, pane, w, h, intensity)
                : { draw: pane, source: whole };
            if (!bounds) continue;
            regions.push({ fx, pane, draw: bounds.draw });
            sources.push(bounds.source);
        }
        if (!sources.length) { this._hide(); return; }
        // Disjoint effect regions (shield hits in different panes) upload as
        // separate rects; one union would copy all the untouched space between
        // them. `mergeUploadRects` keeps a single union for dense/global cases.
        const uploads = this.boundedTransfers && this.disjointUploads !== false
            ? mergeUploadRects(sources) : [sources.reduce(unionRect, null)];
        if (!this._active) { this.canvas.style.display = 'block'; this._active = true; }

        gl.useProgram(this._program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        // Always full resolution: a downscaled upload blurs the whole screen.
        const tw = w, th = h;
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w; this.canvas.height = h;
            this.canvas.style.width = '100vw'; this.canvas.style.height = '100vh';
            gl.viewport(0, 0, w, h);
        }
        if (this._texW !== tw || this._texH !== th) {
            this._texW = tw; this._texH = th;
            // Storage is (re)allocated only when the texture size changes.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        // TexImageSource subrect overload: no crop canvas, ImageBitmap, readback
        // or async copy. Texture Y follows source rows (top-down); the existing
        // fragment shader flips V. Reset unpack state even if a source throws.
        this.lastUploadPixels = 0;
        this.lastUploadRects = uploads.length;
        for (const source of uploads) {
            const full = source.x === 0 && source.y === 0 && source.w === w && source.h === h;
            if (full) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
            } else if (this.cropUploads) {
                // Crop into an exact-size scratch canvas, then upload that.
                const sx = Math.max(0, Math.floor(source.x)), sy = Math.max(0, Math.floor(source.y));
                const sw = Math.min(w - sx, Math.ceil(source.w)), sh = Math.min(h - sy, Math.ceil(source.h));
                if (sw > 0 && sh > 0) {
                    if (!this._crop) { this._crop = document.createElement('canvas'); this._cropCtx = this._crop.getContext('2d'); }
                    if (this._crop.width !== sw || this._crop.height !== sh) { this._crop.width = sw; this._crop.height = sh; }
                    else this._cropCtx.clearRect(0, 0, sw, sh);
                    this._cropCtx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, gl.RGBA, gl.UNSIGNED_BYTE, this._crop);
                }
            } else {
                gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, source.x);
                gl.pixelStorei(gl.UNPACK_SKIP_ROWS, source.y);
                try {
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, source.x, source.y,
                        source.w, source.h, gl.RGBA, gl.UNSIGNED_BYTE, src);
                } finally {
                    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
                    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
                }
            }
            this.lastUploadPixels += source.w * source.h;
        }
        this.lastDrawPixels = 0;
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT); // erase previous frame's affected regions
        gl.uniform2f(this._uRes, w, h);
        gl.uniform1f(this._uTime, time);
        gl.enable(gl.SCISSOR_TEST);
        for (const { fx, pane, draw } of regions) {
            gl.uniform2f(this._uPaneOrigin, pane.x, h - (pane.y + pane.h));
            gl.uniform2f(this._uPaneSize, pane.w, pane.h);
            this._setEffectUniforms(fx, h);
            gl.scissor(Math.round(draw.x), Math.round(h - draw.y - draw.h), Math.round(draw.w), Math.round(draw.h));
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            this.lastDrawPixels += draw.w * draw.h;
        }
        gl.disable(gl.SCISSOR_TEST);
    }

    destroy() {
        this._hide();
        if (this.canvas) {
            this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
            this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
            this.canvas.remove();
        }
        if (this.gl && !this._contextLost) {
            if (this._texture) this.gl.deleteTexture(this._texture);
            if (this._program) this.gl.deleteProgram(this._program);
        }
        this._singleEffect[0] = null;
        this.canvas = null; this.gl = null;
        this._texture = null; this._program = null;
        this._texW = 0; this._texH = 0;
    }

    // Uploads the per-effect uniforms (crt/warp/ripple/flow/collapse). Positions
    // are flipped from top-down canvas coords to gl bottom-up using canvasH.
    // Every strength is scaled by this._intensity (the settings distortion
    // dial) here, so callers never mutate their fx descriptors.
    _setEffectUniforms(fx, canvasH) {
        const gl = this.gl;
        const k = this._intensity !== undefined ? this._intensity : 1;
        const ripple = fx.ripple && fx.ripple.strength * k > 0.004 ? fx.ripple : null;
        const flow = fx.flow && fx.flow.strength * k > 0.004 ? fx.flow : null;
        const collapse = fx.collapse && fx.collapse.strength * k > 0.004 ? fx.collapse : null;
        gl.uniform1f(this._uCrt, Math.min(1, (fx.crt || 0) * k));
        gl.uniform1f(this._uWarp, Math.min(1, (fx.warp || 0) * k));
        if (ripple) {
            gl.uniform4f(this._uRipple, ripple.x, canvasH - ripple.y, ripple.r, ripple.strength * k);
            gl.uniform2f(this._uRippleCenter, ripple.cx, canvasH - ripple.cy);
            gl.uniform1f(this._uRippleT, ripple.t);
        } else {
            gl.uniform4f(this._uRipple, 0, 0, 1, 0);
        }
        if (flow) {
            gl.uniform4f(this._uFlow, flow.x, canvasH - flow.y,
                flow.dirX * flow.strength * k, -flow.dirY * flow.strength * k);
        } else {
            gl.uniform4f(this._uFlow, 0, 0, 0, 0);
        }
        if (collapse) {
            gl.uniform4f(this._uCollapse, collapse.x, canvasH - collapse.y,
                collapse.r, collapse.strength * k);
            gl.uniform1f(this._uCollapseAb, collapse.ab !== undefined ? collapse.ab : 1);
        } else {
            gl.uniform4f(this._uCollapse, 0, 0, 1, 0);
            gl.uniform1f(this._uCollapseAb, 1);
        }
    }
}
