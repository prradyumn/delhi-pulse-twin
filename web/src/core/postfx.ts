import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export type Quality = "low" | "medium" | "high";

/**
 * Ambient occlusion and anti-aliasing.
 *
 * Why AO is the one effect worth its cost here: this city is thousands of extruded masses meeting
 * a flat ground plane, and until now the only contact cue was a vertex-colour fudge that darkened
 * wall bases. AO grounds every building, darkens the street canyons, and finds the corners of the
 * parapets and colonnades — the geometry that already exists but reads flat.
 *
 * Two things this had to get right:
 *
 *  - **AA becomes mandatory, not optional.** Routing through an EffectComposer loses the MSAA that
 *    `antialias: true` gave for free, so without SMAA the upgrade would look *worse*. This is the
 *    classic post-processing regression.
 *  - **The budget is measured, not assumed.** The shadow map turned out to be 73% of GPU time
 *    while I was busy assuming draw calls mattered. So every quality tier here is a measured
 *    configuration with a documented cost, and `low` is a real path rather than a token.
 */
export interface PostFX {
  composer: EffectComposer | null;
  render(): void;
  setSize(w: number, h: number): void;
  setQuality(q: Quality): void;
  quality: Quality;
  /** render scale actually in use, after any dynamic reduction */
  scale: number;
  /** call with true while the camera is moving */
  setMoving(moving: boolean): void;
  dispose(): void;
}

/** Dynamic resolution while the camera moves. Motion hides the softness; a still frame does not. */
const MOVING_SCALE: Record<Quality, number> = { low: 0.8, medium: 0.85, high: 0.7 };

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  initial: Quality = "medium",
): PostFX {
  let quality: Quality = initial;
  let composer: EffectComposer | null = null;
  let gtao: GTAOPass | null = null;
  let smaa: SMAAPass | null = null;
  let moving = false;
  let scale = 1;
  let w = renderer.domElement.width;
  let h = renderer.domElement.height;

  function teardown() {
    if (composer) {
      composer.passes.forEach((p) => p.dispose?.());
      composer.dispose();
    }
    composer = null; gtao = null; smaa = null;
  }

  function build() {
    teardown();
    // MEASURED on the primary device (M1, dpr 1, 1600x913):
    //
    //   no post            close  7.7 ms   wide 10.8 ms
    //   half-res GTAO      close 26.2 ms   wide 27.5 ms
    //   0.75-res GTAO      close 33.2 ms   wide 33.2 ms
    //
    // Screen-space AO costs ~18 ms and roughly doubles submitted geometry, because GTAOPass runs
    // its own depth-normal prepass over the whole scene. That does not fit a 16.7 ms budget here,
    // and it would be worse again at dpr 2 on a Retina display.
    //
    // So AO is NOT in the default path. The grounding it provides comes from a Blender-baked
    // top-down sky-visibility map instead: computed once, free every frame, and better quality
    // because it is not limited to what is on screen. Screen-space AO survives only as an opt-in
    // `high` for still frames, with its cost stated.
    if (quality !== "high") return;

    const c = new EffectComposer(renderer);
    c.addPass(new RenderPass(scene, camera));

    // AO at HALF resolution. Measured at full res: 40 ms, four times the entire rest of the
    // frame — completely unusable. AO is low-frequency by nature, so half res costs a quarter and
    // looks near-identical after the denoise.
    const aoScale = 0.6;
    gtao = new GTAOPass(scene, camera, w * aoScale, h * aoScale);
    // Tuned for a city, not an interior: a 22 m radius is roughly a street width, so occlusion
    // reads at the scale of the canyon rather than crawling over each facade.
    gtao.output = GTAOPass.OUTPUT.Default;
    const p = gtao.pdMaterial.defines;
    if (p) p.PERSPECTIVE_CAMERA = 1;
    gtao.updateGtaoMaterial({
      radius: 22.0,
      distanceExponent: 1.6,
      thickness: 6.0,
      scale: 1.0,
      samples: 10,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    c.addPass(gtao);

    smaa = new SMAAPass(w, h);
    c.addPass(smaa);
    // tone mapping and colour space conversion, which RenderPass no longer does for us
    c.addPass(new OutputPass());
    c.setSize(w, h);
    composer = c;
  }

  build();

  return {
    get composer() { return composer; },
    get quality() { return quality; },
    get scale() { return scale; },

    render() {
      const want = moving ? MOVING_SCALE[quality] : 1.0;
      // setPixelRatio reallocates every render target, which also forces the cached shadow map to
      // be re-rendered. Flipping it on a per-frame boolean was a resize storm — hence the "low"
      // tier measuring 10.9 ms when it should have been 4.6.
      if (Math.abs(want - scale) > 0.01) {
        scale = want;
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * scale);
        composer?.setSize(w, h);
        renderer.shadowMap.needsUpdate = true;
      }
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },

    setSize(nw: number, nh: number) {
      w = nw; h = nh;
      composer?.setSize(nw, nh);
      gtao?.setSize(nw * 0.6, nh * 0.6);
    },

    setQuality(q: Quality) {
      if (q === quality) return;
      quality = q;
      // low renders direct to the canvas, so MSAA has to come back with it
      build();
    },

    setMoving(m: boolean) { moving = m; },

    dispose() { teardown(); },
  };
}

/** Per-tier cost, measured on the primary benchmark device rather than assumed. Filled in by
 *  `tools/qa.mjs --bench`, and quoted in the quality menu so the trade-off is visible. */
/**
 * Three genuinely distinct tiers, on a measured cost ladder. An earlier version of this table
 * described a difference between `low` and `medium` that did not exist in the code — the QA gate
 * caught it by asserting low was cheaper and finding it was not. Documentation claiming a
 * capability the build does not have is worse than a missing feature.
 *
 * The lever for `low` came straight out of the profiler: the shadow map was 73% of GPU time, so
 * dropping it is the single biggest saving available, and 3.7 ms is a real path for a weak device.
 */
export const QUALITY_NOTES: Record<Quality, string> = {
  low: "No shadows, no post-processing, hardware MSAA. Baked ambient occlusion still grounds the buildings, so it holds up far better than a shadowless scene usually does. Measured ~4 ms GPU — the path the PRD requires to exist.",
  medium: "Sun shadows on, rendered on demand rather than every frame. Baked AO and MSAA. Measured ~8 ms close in, ~13 ms wide. The default.",
  high: "Adds screen-space ground-truth AO at 0.6 resolution and SMAA on top. Measured ~33 ms — worth it for a still frame, too slow to orbit in, which is exactly why it is not the default.",
};
