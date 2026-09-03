import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Renderer, scene, sun/sky and camera. Restrained on purpose: the PRD's visual standard is
 *  "geographically faithful, lightly stylised PBR" — no bloom, no neon, nothing that hides data. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;

  constructor(canvas: HTMLCanvasElement, extent: { x: [number, number]; z: [number, number] }) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: "high-performance", stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = false;   // 3,203 buildings; shadows are not worth the frame time

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

    this.scene.background = new THREE.Color(0xcfd8dd);
    this.scene.fog = new THREE.Fog(0xcfd8dd, span * 0.55, span * 2.1);

    this.hemi = new THREE.HemisphereLight(0xdfe8f0, 0x8d8578, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    this.sun.position.set(-1200, 1800, 900);
    this.scene.add(this.sun);
  }

  /** Sun elevation and colour follow the time control, so the light itself is a time cue. */
  setTime(min: number) {
    const t = Math.min(Math.max((min - 5 * 60) / (19 * 60 - 5 * 60), 0), 1);
    const el = Math.sin(t * Math.PI);                      // 0 at 05:00 and 19:00, 1 at midday
    const az = (t - 0.5) * Math.PI * 1.15;
    const r = 2200;
    this.sun.position.set(Math.sin(az) * r, Math.max(el, 0.03) * 1900 + 60, Math.cos(az) * r * 0.4);
    this.sun.intensity = 0.35 + el * 1.95;
    const warm = 1 - el;
    // Three's working colour space is linear-sRGB, and setRGB/setHSL interpret their arguments in
    // it unless told otherwise. These are hand-picked sRGB values, so say so — left implicit the
    // sun goes muddy and the sky desaturates.
    this.sun.color.setRGB(1, 0.95 - warm * 0.19, 0.86 - warm * 0.36, THREE.SRGBColorSpace);
    this.hemi.intensity = 0.35 + el * 0.6;
    const sky = new THREE.Color().setHSL(
      0.58 - warm * 0.06, 0.16 + warm * 0.2, 0.52 + el * 0.28, THREE.SRGBColorSpace);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);
  }

  resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() { this.controls.update(); this.renderer.render(this.scene, this.camera); }
}
