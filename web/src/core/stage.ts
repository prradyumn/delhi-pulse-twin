import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FACADE_UNIFORMS } from "../layers/facade";

/** Renderer, scene, sun/sky and camera. Restrained on purpose: the PRD's visual standard is
 *  "geographically faithful, lightly stylised PBR" — no bloom, no neon, nothing that hides data. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sky: THREE.Mesh;
  private fill!: THREE.DirectionalLight;

  constructor(canvas: HTMLCanvasElement, extent: { x: [number, number]; z: [number, number] }) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: "high-performance", stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Shadows were switched off on the assumption they would cost too much. Measured instead:
    // the whole scene is 76k triangles in 13 draw calls, so one 2048 map is affordable and it is
    // the single largest realism gain available — a city without contact shadows reads as a model.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const span = Math.max(extent.x[1] - extent.x[0], extent.z[1] - extent.z[0]);
    this.camera = new THREE.PerspectiveCamera(48, 1, 5, span * 6);
    this.camera.position.set(900, 900, 1500);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;   // never below the ground plane
    this.controls.minDistance = 60;
    this.controls.maxDistance = span * 1.6;
    this.controls.target.set(0, 0, 0);

    this.scene.fog = new THREE.Fog(0xcfd8dd, span * 0.75, span * 2.7);

    // A flat background colour is what makes a 3D scene look like a screenshot of a 3D scene.
    // This dome carries a real horizon gradient and haze band, and it costs one draw call.
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(span * 2.7, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color(0x6f9dc4) },
          uHorizon: { value: new THREE.Color(0xd9dfe0) },
          uHaze: { value: new THREE.Color(0xe8e2d4) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uHaze;
          uniform vec3 uSunDir;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, -1.0, 1.0);
            // tighter falloff near the horizon than a linear mix, which is what reads as depth
            vec3 c = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
            // low, wide glow toward the sun rather than a hard disc
            float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
            c = mix(c, uHaze, pow(sd, 3.5) * 0.34 * (1.0 - clamp(h, 0.0, 1.0)) );
            // dust band sitting on the horizon — Delhi is hazy and a clean horizon looks wrong
            c = mix(c, uHaze, exp(-abs(h) * 11.0) * 0.30);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xdfe8f0, 0x8d8578, 0.62);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    this.sun.position.set(-1200, 1800, 900);
    this.sun.castShadow = true;
    // 2048 over the whole 4 km box works out at 2.5 m per shadow texel — technically shadows,
    // visually nothing. 4096 over a tightened box gives ~1 m, which is the scale of the thing
    // casting them.
    this.sun.shadow.mapSize.set(4096, 4096);
    const half = span * 0.53;
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = 200; sc.far = span * 2.6;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.scene.add(this.sun);
    // a dim fill from the opposite side so north faces are shaped rather than flat black
    const fill = new THREE.DirectionalLight(0xbcd0e6, 0.35);
    fill.position.set(1400, 700, -1100);
    this.scene.add(fill);
    this.fill = fill;
  }

  /**
   * Sun position, sky and window lighting from one clock value.
   *
   * The first version mapped 05:00–19:00 onto a half sine and clamped outside it, which meant the
   * scene was stuck at sunset from 19:00 to 05:00 — permanently brown, never night. This runs a
   * signed elevation instead: positive through the day, negative after dark, so there is a real
   * night phase and dusk is a crossing rather than an endpoint.
   *
   * Sunrise and sunset are Delhi in early September, near enough for a lighting model.
   */
  setTime(min: number) {
    const SUNRISE = 6 * 60 + 5;
    const SUNSET = 18 * 60 + 40;
    const day = (min - SUNRISE) / (SUNSET - SUNRISE);      // 0..1 across daylight
    const el = Math.sin(Math.PI * day);                    // negative outside it
    const above = Math.max(el, 0);
    const night = Math.min(Math.max(-el * 2.6, 0), 1);     // 0 at sunset, 1 well after dark
    // 0 at midday, 1 at the horizon — drives the warm, low-sun colours
    const warm = 1 - above;

    const az = (Math.min(Math.max(day, 0), 1) - 0.5) * Math.PI * 1.15;
    const r = 2200;
    this.sun.position.set(Math.sin(az) * r, Math.max(el, 0.02) * 1900 + 60,
                          Math.cos(az) * r * 0.4);
    this.sun.intensity = 0.02 + above * 2.15;
    // Three's working colour space is linear-sRGB and setRGB/setHSL read their arguments in it
    // unless told otherwise; these are hand-picked sRGB values, so say so.
    this.sun.color.setRGB(1, 0.95 - warm * 0.19, 0.86 - warm * 0.36, THREE.SRGBColorSpace);

    // At night the sky stops being the light source and the city becomes it: a dim, warm ground
    // bounce standing in for street lighting, so the ground is dark but not pitch black.
    // Delhi's skyglow is considerable, so a dim ground reads truer than a black one — and an
    // unreadable city is not a more honest city.
    this.hemi.intensity = 0.52 + above * 0.52;
    this.hemi.color.setHSL(0.60 - night * 0.02, 0.16 + night * 0.10,
                           0.60 - night * 0.24, THREE.SRGBColorSpace);
    this.hemi.groundColor.setHSL(0.085, 0.20 + night * 0.16, 0.26 + night * 0.04,
                                 THREE.SRGBColorSpace);
    this.fill.intensity = 0.05 + above * 0.30;

    const mat = this.sky.material as THREE.ShaderMaterial;
    // Hue 0.14 is yellow-green and turned the whole horizon olive; Delhi's haze is a warm
    // neutral, so the horizon stays barely saturated and the zenith carries the blue.
    const zenith = new THREE.Color().setHSL(
      0.60 - warm * 0.02, 0.42 - above * 0.06, (0.26 + above * 0.36) * (1 - night * 0.88),
      THREE.SRGBColorSpace);
    // dusk keeps its warmth; deep night loses it, or the sky reads as a permanent sunset
    const duskWarmth = Math.max(1 - night * 1.5, 0);
    const horizon = new THREE.Color().setHSL(
      0.075 + above * 0.01, (0.08 + warm * 0.24) * duskWarmth,
      (0.66 + above * 0.20) * (1 - night * 0.80), THREE.SRGBColorSpace);
    const haze = new THREE.Color().setHSL(
      0.065 + above * 0.01, (0.11 + warm * 0.28) * duskWarmth,
      (0.70 + above * 0.18) * (1 - night * 0.76), THREE.SRGBColorSpace);
    mat.uniforms.uZenith.value.copy(zenith);
    mat.uniforms.uHorizon.value.copy(horizon);
    mat.uniforms.uHaze.value.copy(haze);
    mat.uniforms.uSunDir.value.copy(this.sun.position).normalize();
    // distant geometry dissolves into the sky rather than into grey
    (this.scene.fog as THREE.Fog).color.copy(horizon).lerp(haze, 0.45);

    // windows come on as the sun goes down; the clock is the only thing that decides
    FACADE_UNIFORMS.uNight.value = Math.min(Math.max(1 - above / 0.30, 0), 1);
  }

  resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    // keep the dome centred on the camera so it never clips at the far plane
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
