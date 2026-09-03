import * as THREE from "three";
import type { Layer, LayerReport } from "./registry";
import type { Provenance } from "../geo/types";
import type { Raster } from "../analysis/network";

/**
 * The reach overlay: an isochrone field painted on the ground.
 *
 * One plane, one draw call, one small texture. The minutes value is stored *in* the texture and
 * banded in the fragment shader rather than baked into pixel colours, which is what lets the band
 * edges stay smooth at any zoom and lets a contour line be drawn exactly on each boundary. Baking
 * colours into a 197×205 texture and filtering it would blur the ramp instead of the geometry.
 *
 * The plane sits at y = 0.09: above the road surface (0.02) and the footways (0.008), below the
 * roof of every building.
 *
 * Which raises a problem that only showed up in a render. Depth-tested, the field is paint on the
 * ground — correct, and unreadable from 1 km up over Connaught Place, because the near bands fall
 * in the thin gaps between buildings while the far bands sit on the open Rajpath lawns. The
 * brightest, most informative part of the field was almost entirely hidden under rooftops, and the
 * least informative part covered a third of the screen. Nothing was wrong with the colours; the
 * geometry was hiding the answer.
 *
 * So there are two modes, and the difference is honest rather than cosmetic. From above, MAP MODE
 * drops the depth test and the field reads as a layer drawn over the city — which is what an
 * isochrone map is, and how every transit isochrone has been drawn since Galton. At street level
 * the depth test comes back and it is paint on the pavement in front of you, at the scale you are
 * standing in.
 */

/** cumulative minute bands. Five is as many as a reader can hold; 5-minute steps to 25. */
export const BANDS = [5, 10, 15, 20, 25];

/**
 * Cool sequential ramp, deliberately unlike the warm traffic ramp and the green-to-red air ramp so
 * three overlays can never be mistaken for one another.
 *
 * Brightest at the centre and fading outward, which took a correction: the first version ran dark
 * at the far edge, and on a city already in 08:30 shadow the 25-minute band read as shadow rather
 * than as information — the least interesting part of the field was the most prominent thing on
 * screen. Near is where the answer is, so near is where the ink goes, and the field fades out as
 * the time runs out.
 */
export const BAND_COLOURS = ["#eafff9", "#93f0e3", "#46c8d8", "#2e8fc4", "#5478b4"];
/** per-band opacity multiplier, so the far edge recedes instead of competing */
export const BAND_ALPHA = [1.0, 0.94, 0.84, 0.70, 0.52];
/** default overlay opacity, and the factor applied when it is drawn over rooftops rather than
 *  depth-tested onto the ground */
export const BASE_OPACITY = 0.72;
const MAP_MODE_DIM = 0.72;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uField;
  uniform vec3  uRamp[5];
  uniform float uRampA[5];
  uniform float uBands[5];
  uniform float uMax;
  uniform float uOpacity;
  uniform float uCompare;    // 0 = single field, 1 = difference of the two packed fields
  uniform float uContour;
  varying vec2 vUv;

  vec4 rampAt(float minutes) {
    vec4 c = vec4(uRamp[4], uRampA[4]);
    for (int i = 4; i >= 0; i--) {
      if (minutes <= uBands[i]) c = vec4(uRamp[i], uRampA[i]);
    }
    return c;
  }

  void main() {
    vec4 f = texture2D(uField, vUv);
    float mask = f.g;
    if (mask < 0.30) discard;

    float minutes = f.r * uMax;
    vec3 col;
    float a = uOpacity;

    if (uCompare > 0.5) {
      // What the step-free route costs you. Cells the step-free network cannot reach at all are
      // the strong signal here, so they get their own treatment rather than a ramp value.
      float freeMask = f.a;
      float freeMin  = f.b * uMax;
      if (freeMask < 0.30) {
        col = vec3(0.62, 0.16, 0.20);        // unreachable without steps
        a *= 1.25;
      } else {
        float extra = max(freeMin - minutes, 0.0);
        // 0, 2, 5, 10, 20+ extra minutes
        col = extra < 0.5  ? vec3(0.82, 0.86, 0.83)
            : extra < 2.0  ? vec3(0.95, 0.87, 0.62)
            : extra < 5.0  ? vec3(0.90, 0.66, 0.36)
            : extra < 10.0 ? vec3(0.79, 0.40, 0.26)
                           : vec3(0.62, 0.16, 0.20);
        if (extra < 0.5) a *= 0.45;          // "no penalty" should recede
      }
    } else {
      vec4 r = rampAt(minutes);
      col = r.rgb;
      a *= r.a;
      // A contour exactly on each band boundary, one pixel wide whatever the zoom. fwidth gives
      // the screen-space rate of change, which is the only way to keep it one pixel.
      float step = uBands[0];
      float t = minutes / step;
      float d = abs(fract(t) - 0.5) / max(fwidth(t), 1e-5);
      float line = 1.0 - smoothstep(0.0, 1.2, d * 0.55);
      col = mix(col, col * 0.42, line * uContour);
    }

    gl_FragColor = vec4(col, a * smoothstep(0.30, 0.62, mask));

    // A raw ShaderMaterial gets none of the fragment chunks a MeshStandardMaterial does, so this
    // include is not optional: without it the linear ramp above is written unconverted to an sRGB
    // framebuffer and the whole overlay comes out roughly half as bright as authored. Three
    // resolves the include against the active target, which also keeps it correct when the high-quality
    // tier routes through the composer's linear buffer.
    #include <colorspace_fragment>
  }
`;

export interface ReachStats {
  reachedKm2: number[];
  nodesReached: number;
}

export class ReachLayer implements Layer {
  id = "reach"; label = "Reach on foot";
  group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private tex: THREE.DataTexture | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private w = 0; private h = 0;
  private opacity = BASE_OPACITY;
  /** filled in once a graph has been built, so the report can state what it was built from */
  netNote: string[] = [];

  constructor(
    private extent: { x: [number, number]; z: [number, number] },
    private maxMinutes = 30,
  ) {}

  async build(): Promise<LayerReport> {
    const prov: Provenance = {
      provider: "Derived (this prototype)",
      dataset: "Walk-time isochrones over the OSM pedestrian network",
      license: "Derived from OSM geometry, ODbL 1.0",
      attribution: "© OpenStreetMap contributors — road and footway geometry",
      retrieved_at: "2026-09-03", source_time: null,
      refresh_cadence: "recomputed on demand, deterministic",
      bounds: [77.1975, 28.6039, 77.2385, 28.6401], crs: "EPSG:32643 + local origin",
      mode: "estimated", transform_version: "0.1.0",
      limitations: [
        "The network is OBSERVED (684 OSM road ways, 926 footway ways). The minutes are ESTIMATED: 4.8 km/h on the level and 1.6 km/h on ways tagged highway=steps, both declared figures rather than measurements.",
        "No crossing or signal delay is modelled. Waiting to cross a road like Baba Kharak Singh Marg is real time this field does not charge you, so reach is over-stated wherever a route crosses a main road.",
        "Footways mapped separately from the carriageway are joined to the nearest way within 15 m, by projecting onto the segment rather than matching a vertex. Without it the graph is 45% connected and unusable; with it, 86%. A few of those joins will not exist on the ground.",
        "The last leg from the nearest mapped way to a given point is charged as a straight line and capped at 70 m. Blocks further than that from any mapped way are left blank, not guessed — the blank areas inside compound walls are the finding, not a gap in the render.",
        "Nothing here models whether a footway is walkable in practice. Delhi footways are routinely parked on, dug up or absent behind a mapped line.",
      ],
    };
    const base: LayerReport = { id: this.id, label: this.label, status: "pending",
      provenance: prov, features: 0, bytes: 0, ms: 0, drawCalls: 0, triangles: 0 };

    const gw = this.extent.x[1] - this.extent.x[0];
    const gh = this.extent.z[1] - this.extent.z[0];
    const geo = new THREE.PlaneGeometry(gw, gh, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate((this.extent.x[0] + this.extent.x[1]) / 2, 0.09,
                  (this.extent.z[0] + this.extent.z[1]) / 2);

    const ramp = BAND_COLOURS.map((c) => new THREE.Color(c).convertSRGBToLinear());
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uField: { value: null },
        uRamp: { value: ramp },
        uRampA: { value: BAND_ALPHA.slice() },
        uBands: { value: BANDS.slice() },
        uMax: { value: this.maxMinutes },
        uOpacity: { value: BASE_OPACITY * MAP_MODE_DIM },
        uCompare: { value: 0 },
        uContour: { value: 1 },
      },
      transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      // the overlay is information, not a lit surface: it must read the same at 06:00 and 21:00
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = "reach";
    this.mesh.renderOrder = 900;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.group.visible = false;      // opt-in: it hides the city underneath

    return { ...base, status: "ready", features: 0, drawCalls: 1, triangles: 2 };
  }

  /** Upload a field, optionally with a second field to compare against. */
  setField(main: Raster, compare?: Raster | null): ReachStats {
    if (this.w !== main.w || this.h !== main.h || !this.data) {
      this.w = main.w; this.h = main.h;
      this.data = new Uint8Array(new ArrayBuffer(this.w * this.h * 4));
      this.tex?.dispose();
      this.tex = new THREE.DataTexture(this.data, this.w, this.h, THREE.RGBAFormat);
      this.tex.minFilter = THREE.LinearFilter;
      this.tex.magFilter = THREE.LinearFilter;
      this.tex.wrapS = THREE.ClampToEdgeWrapping;
      this.tex.wrapT = THREE.ClampToEdgeWrapping;
      this.tex.generateMipmaps = false;
      if (this.mat) this.mat.uniforms.uField.value = this.tex;
    }
    const d = this.data;
    const M = this.maxMinutes;
    let reached = 0;
    const cellKm2 = (main.cell * main.cell) / 1e6;
    const areas = BANDS.map(() => 0);

    for (let i = 0; i < main.min.length; i++) {
      const v = main.min[i];
      const ok = Number.isFinite(v) && v <= M;
      d[i * 4 + 0] = ok ? Math.min(255, Math.round((v / M) * 255)) : 255;
      d[i * 4 + 1] = ok ? 255 : 0;
      if (compare) {
        const c = compare.min[i];
        const cok = Number.isFinite(c) && c <= M;
        d[i * 4 + 2] = cok ? Math.min(255, Math.round((c / M) * 255)) : 255;
        d[i * 4 + 3] = cok ? 255 : 0;
      } else {
        d[i * 4 + 2] = 0; d[i * 4 + 3] = 0;
      }
      if (ok) {
        reached++;
        for (let b = 0; b < BANDS.length; b++) if (v <= BANDS[b]) areas[b] += cellKm2;
      }
    }
    if (this.tex) this.tex.needsUpdate = true;
    if (this.mat) this.mat.uniforms.uCompare.value = compare ? 1 : 0;
    return { reachedKm2: areas, nodesReached: reached };
  }

  /** Map mode draws over rooftops, so it needs to be lighter or it buries the city it describes. */
  private applyOpacity() {
    if (!this.mat) return;
    const mapMode = !this.mat.depthTest;
    this.mat.uniforms.uOpacity.value = this.opacity * (mapMode ? MAP_MODE_DIM : 1);
  }

  setOpacity(v: number) { this.opacity = v; this.applyOpacity(); }

  /** true = drawn over the city as a map layer; false = depth-tested paint on the ground. */
  setMapMode(on: boolean) {
    if (!this.mat || !this.mesh) return;
    this.mat.depthTest = !on;
    this.mesh.renderOrder = on ? 900 : 3;
    this.applyOpacity();
  }
  setContour(on: boolean) { if (this.mat) this.mat.uniforms.uContour.value = on ? 1 : 0; }
  setVisible(v: boolean) { this.group.visible = v; }
  get visible() { return this.group.visible; }
  dispose() {
    this.mesh?.geometry.dispose();
    this.mat?.dispose();
    this.tex?.dispose();
  }
}
