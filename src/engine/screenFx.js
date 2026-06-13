// Full-screen CRT-style post-processing (chromatic aberration, vignette,
// barrel distortion) driven by an intensity value 0..1 — used by the
// kill-streak escalation (and later, story-dread effects).
//
// The game renders on a 2D canvas; this samples that canvas into a WebGL2
// texture each frame and draws a distorted fullscreen pass on an overlay
// canvas stacked above it. The overlay is hidden and the pass skipped
// entirely while intensity is 0, so the idle cost is zero. If WebGL2 is
// unavailable it degrades to a silent no-op.

const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_crt;    // kill-streak CRT look (barrel/chroma/vignette)
uniform float u_warp;   // dread insanity pulse (wobble/tear/desaturate)
uniform vec4 u_ripple;  // shield impact: xy = impact point (px), z = bubble radius (px), w = strength
uniform vec2 u_rippleCenter; // bubble center (px) for the area mask
uniform float u_rippleT;     // seconds since impact
uniform vec4 u_flow;     // boost: xy = ship (px), zw = travel dir * strength
uniform vec4 u_collapse; // teleport: xy = ship (px), z = radius (px), w = strength
uniform float u_time;
out vec4 outColor;

void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    vec2 c = uv - 0.5;
    float aspect = u_res.x / u_res.y;
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
        duv += dir * (band * mask * u_ripple.w * 5.0) / u_res;
    }

    // ── Boost flow: space bends around the hull along the line of travel ──
    float flowStr = length(u_flow.zw);
    if (flowStr > 0.001) {
        vec2 d = gl_FragCoord.xy - u_flow.xy;
        vec2 fdir = u_flow.zw / flowStr;
        float R = 0.30 * min(u_res.x, u_res.y);
        float fall = exp(-dot(d, d) / (R * R));
        vec2 fperp = vec2(-fdir.y, fdir.x);
        // Space contracts toward the ship along the travel axis — compressed
        // ahead of the nose, stretched out behind it (a uniform shift reads
        // as nothing at speed; the variation across the screen is the bend)
        float along = dot(d, fdir);
        duv += fdir * along * fall * flowStr * 0.22 / u_res;
        // ...dragged back past the hull...
        duv += fdir * (fall * flowStr * R * 0.13) / u_res;
        // ...and pinched in toward the line of travel
        duv += fperp * dot(d, fperp) * fall * flowStr * 0.22 / u_res;
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
        duv += (d / dist) * (fall * ramp * amt) / u_res;
    }

    // Chromatic aberration: CRT separates at edges; warp separates everywhere;
    // boost/teleport distortion fringes a touch near full strength
    float s = 0.011 * u_crt * r2 + 0.004 * u_warp
            + 0.002 * flowStr + 0.003 * u_collapse.w;
    // The source canvas is uploaded WITHOUT UNPACK_FLIP_Y_WEBGL (that flag forces
    // a slow per-frame CPU copy for canvas texture sources in Chrome). The
    // texture is therefore stored vertically mirrored; we cancel that by flipping
    // the sample V here. Two mirrors == identity, so the sampled pixels are
    // byte-for-byte what they were before — only the upload got cheaper.
    vec2 sr = duv * (1.0 + s) + 0.5;
    vec2 sg = duv + 0.5;
    vec2 sb = duv * (1.0 - s) + 0.5;
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
        this._active = false;
        this._texW = 0;
        this._texH = 0;
    }

    _init() {
        try {
            const canvas = document.createElement('canvas');
            canvas.id = 'fxCanvas';
            canvas.style.position = 'fixed';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.pointerEvents = 'none';
            canvas.style.display = 'none';
            const gl = canvas.getContext('webgl2', {
                alpha: false, depth: false, stencil: false,
                antialias: false, premultipliedAlpha: false,
                preserveDrawingBuffer: false
            });
            if (!gl) { this._failed = true; return; }
            document.body.appendChild(canvas);

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
            gl.useProgram(prog);

            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);

            this.canvas = canvas;
            this.gl = gl;
            this._uRes = gl.getUniformLocation(prog, 'u_res');
            this._uCrt = gl.getUniformLocation(prog, 'u_crt');
            this._uWarp = gl.getUniformLocation(prog, 'u_warp');
            this._uRipple = gl.getUniformLocation(prog, 'u_ripple');
            this._uRippleCenter = gl.getUniformLocation(prog, 'u_rippleCenter');
            this._uRippleT = gl.getUniformLocation(prog, 'u_rippleT');
            this._uFlow = gl.getUniformLocation(prog, 'u_flow');
            this._uCollapse = gl.getUniformLocation(prog, 'u_collapse');
            this._uTime = gl.getUniformLocation(prog, 'u_time');
        } catch (e) {
            console.error('[ScreenFX] init failed, disabling post-fx:', e);
            this._failed = true;
            if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
            this.canvas = null;
            this.gl = null;
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
    render(fx, time) {
        if (this._failed) return;
        const crt = fx.crt || 0, warp = fx.warp || 0;
        const ripple = fx.ripple && fx.ripple.strength > 0.004 ? fx.ripple : null;
        const flow = fx.flow && fx.flow.strength > 0.004 ? fx.flow : null;
        const collapse = fx.collapse && fx.collapse.strength > 0.004 ? fx.collapse : null;
        if (crt <= 0.004 && warp <= 0.004 && !ripple && !flow && !collapse) {
            if (this._active) {
                this.canvas.style.display = 'none';
                this._active = false;
            }
            return;
        }
        if (!this.gl) {
            this._init();
            if (this._failed) return;
        }

        const src = this.game.canvas;
        const gl = this.gl;
        if (!this._active) {
            this.canvas.style.display = 'block';
            this._active = true;
        }

        // Match the game canvas backing size (device pixels)
        if (this._texW !== src.width || this._texH !== src.height) {
            this._texW = src.width;
            this._texH = src.height;
            this.canvas.width = src.width;
            this.canvas.height = src.height;
            this.canvas.style.width = '100vw';
            this.canvas.style.height = '100vh';
            gl.viewport(0, 0, src.width, src.height);
            // No UNPACK_FLIP_Y_WEBGL — it triggers a slow CPU copy for canvas
            // sources. The fragment shader flips the sample V instead (identical
            // result, far cheaper upload). texSubImage2D reuses the allocation.
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
        }

        gl.uniform2f(this._uRes, src.width, src.height);
        gl.uniform1f(this._uCrt, Math.min(1, crt));
        gl.uniform1f(this._uWarp, Math.min(1, warp));
        if (ripple) {
            // gl_FragCoord is bottom-up; canvas coords are top-down
            gl.uniform4f(this._uRipple, ripple.x, src.height - ripple.y, ripple.r, ripple.strength);
            gl.uniform2f(this._uRippleCenter, ripple.cx, src.height - ripple.cy);
            gl.uniform1f(this._uRippleT, ripple.t);
        } else {
            gl.uniform4f(this._uRipple, 0, 0, 1, 0);
        }
        if (flow) {
            // gl_FragCoord is bottom-up; canvas coords are top-down (flip y of
            // both the position and the travel direction)
            gl.uniform4f(this._uFlow, flow.x, src.height - flow.y,
                flow.dirX * flow.strength, -flow.dirY * flow.strength);
        } else {
            gl.uniform4f(this._uFlow, 0, 0, 0, 0);
        }
        if (collapse) {
            gl.uniform4f(this._uCollapse, collapse.x, src.height - collapse.y,
                collapse.r, collapse.strength);
        } else {
            gl.uniform4f(this._uCollapse, 0, 0, 1, 0);
        }
        gl.uniform1f(this._uTime, time);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
}
