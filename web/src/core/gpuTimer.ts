/**
 * GPU frame time via EXT_disjoint_timer_query_webgl2.
 *
 * The performance budget was gating on CPU frame time, which said 1.4 ms and told us nothing about
 * the thing that actually limits visual quality. Every screen-space effect — AO, AA, reflections —
 * is fragment work, and fragment work scales with pixels, not with JavaScript.
 *
 * Two facts this exists to keep honest:
 *
 *  - A headless browser reports `devicePixelRatio: 1`. A Retina display reports 2, and we cap
 *    there, so the real render is **four times the pixels** measured in CI. A budget verified only
 *    in headless is not verified.
 *  - Timer queries are asynchronous and can be *disjoint* (the driver preempted, so the result is
 *    garbage). Disjoint results must be thrown away, not averaged in.
 */

export interface GpuSample {
  /** rolling mean GPU ms, or null until the first query resolves */
  ms: number | null;
  /** queries discarded because the driver reported a disjoint interval */
  disjoint: number;
  supported: boolean;
}

export class GpuTimer {
  private ext: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private inFlight: WebGLQuery[] = [];
  private samples: number[] = [];
  private disjointCount = 0;
  private active: WebGLQuery | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2");
    if (!gl) return;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as
      | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
      | null;
    if (!ext) return;
    this.gl = gl;
    this.ext = ext;
  }

  get supported() { return this.gl !== null && this.ext !== null; }

  /** Call immediately before the render. Silently no-ops when unsupported or already active. */
  begin() {
    if (!this.gl || !this.ext || this.active) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  /** Call immediately after the render, then harvest whatever has resolved. */
  end() {
    if (!this.gl || !this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.inFlight.push(this.active);
    this.active = null;
    this.harvest();
  }

  private harvest() {
    const gl = this.gl!;
    const ext = this.ext!;
    // A disjoint interval means the driver interrupted us; every query still in flight is suspect.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      this.disjointCount += this.inFlight.length;
      for (const q of this.inFlight) gl.deleteQuery(q);
      this.inFlight.length = 0;
      return;
    }
    const still: WebGLQuery[] = [];
    for (const q of this.inFlight) {
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        gl.deleteQuery(q);
        this.samples.push(ns / 1e6);
        if (this.samples.length > 60) this.samples.shift();
      } else {
        still.push(q);
      }
    }
    this.inFlight = still;
  }

  /** Drop every accumulated sample. Essential when A/B-ing configurations: a rolling mean that
   *  spans the change blends the two answers together, which is how "removing 460k triangles made
   *  it slower" happens. */
  reset() {
    this.samples.length = 0;
    this.disjointCount = 0;
  }

  /** Median is the statistic to quote, not the mean: one driver hitch skews a mean badly. */
  median(): number | null {
    if (!this.samples.length) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  count() { return this.samples.length; }

  sample(): GpuSample {
    if (!this.samples.length) {
      return { ms: null, disjoint: this.disjointCount, supported: this.supported };
    }
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    return { ms: mean, disjoint: this.disjointCount, supported: this.supported };
  }

  /** Pixels actually being rasterised — the number the fragment budget is really about. */
  static pixelLoad(canvas: HTMLCanvasElement) {
    return {
      px: canvas.width * canvas.height,
      dpr: window.devicePixelRatio,
      note: canvas.width * canvas.height > 3.5e6
        ? "high pixel load — screen-space effects cost roughly 4x what they do at dpr 1"
        : "moderate pixel load",
    };
  }
}
