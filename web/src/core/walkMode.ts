import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Street-level camera.
 *
 * Everything built in the last few passes — facade windows, rooftop water tanks, kerbs, parapets,
 * 17,000 trees, 2,200 walkers — is invisible from 2 km up. This is the cheapest way to make that
 * work visible, and it is also the view in which the exposure figures make sense: the dose you
 * breathe waiting at a stop is a street-level quantity.
 *
 * Deliberately a walk and not a fly: eye height is fixed at 1.7 m and the ground plane is flat in
 * this pilot, so there is no terrain to follow. Movement is clamped to the locked study box,
 * because leaving it would show the empty void beyond the clip boundary.
 */
export class WalkMode {
  active = false;
  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private savedPos = new THREE.Vector3();
  private savedTarget = new THREE.Vector3();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  readonly eyeHeight = 1.7;
  /** metres per second; roughly a brisk walk, with shift for a jog */
  speed = 6.5;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    private dom: HTMLElement,
    private extent: { x: [number, number]; z: [number, number] },
    private onChange?: (active: boolean) => void,
  ) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    dom.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointermove", this.onMove);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (this.active) this.keys.add(e.key.toLowerCase());
    if (e.key === "Escape" && this.active) this.exit();
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };
  private onDown = (e: PointerEvent) => {
    if (!this.active) return;
    this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
  };
  private onUp = () => { this.dragging = false; };
  private onMove = (e: PointerEvent) => {
    if (!this.active || !this.dragging) return;
    this.yaw -= (e.clientX - this.lastX) * 0.0032;
    // clamp the pitch short of straight up or down: past that the horizon flips and the
    // controls feel broken
    this.pitch = Math.max(Math.min(this.pitch - (e.clientY - this.lastY) * 0.0028, 1.2), -1.0);
    this.lastX = e.clientX; this.lastY = e.clientY;
  };

  /** Enter at a given ground position, or at whatever the orbit camera was looking at. */
  enter(at?: [number, number]) {
    if (this.active) return;
    this.savedPos.copy(this.camera.position);
    this.savedTarget.copy(this.controls.target);

    const x = at ? at[0] : this.controls.target.x;
    const z = at ? at[1] : this.controls.target.z;
    // face the way the orbit camera was facing, so entering does not disorient
    const dir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = -0.05;

    this.camera.position.set(x, this.eyeHeight, z);
    this.controls.enabled = false;
    this.active = true;
    this.dom.style.cursor = "grab";
    this.onChange?.(true);
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    this.dragging = false;
    this.camera.position.copy(this.savedPos);
    this.controls.target.copy(this.savedTarget);
    this.controls.enabled = true;
    this.controls.update();
    this.dom.style.cursor = "";
    this.onChange?.(false);
  }

  toggle(at?: [number, number]) { this.active ? this.exit() : this.enter(at); }

  /** Called from the render loop. dt in milliseconds. */
  update(dtMs: number) {
    if (!this.active) return;
    const dt = Math.min(dtMs, 100) / 1000;
    const sprint = this.keys.has("shift") ? 2.4 : 1;
    const v = this.speed * sprint * dt;

    let fwd = 0, side = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) fwd += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) fwd -= 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) side -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) side += 1;

    if (fwd || side) {
      const len = Math.hypot(fwd, side) || 1;
      // movement is horizontal regardless of where you are looking, which is what walking is
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      this.camera.position.x += ((-sy * fwd) + (cy * side)) / len * v;
      this.camera.position.z += ((-cy * fwd) + (-sy * side)) / len * v;
      // stay inside the locked box: beyond it there is nothing but the clip boundary
      const pad = 30;
      this.camera.position.x = Math.max(Math.min(this.camera.position.x, this.extent.x[1] - pad),
                                        this.extent.x[0] + pad);
      this.camera.position.z = Math.max(Math.min(this.camera.position.z, this.extent.z[1] - pad),
                                        this.extent.z[0] + pad);
    }
    this.camera.position.y = this.eyeHeight;

    const look = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(
      this.camera.position.x + look.x,
      this.camera.position.y + look.y,
      this.camera.position.z + look.z,
    );
  }

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.dom.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointermove", this.onMove);
  }
}
