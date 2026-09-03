import * as THREE from "three";

const c = (hex: number) => new THREE.Color(hex);

/** Grounded in the study area itself: Lutyens' Delhi is lime-washed stucco and red sandstone on
 *  dust, cut by very large lawns. Restrained on purpose — the PRD forbids anything that hides data. */
export const PALETTE = {
  bare:      c(0xc9bca8),
  green:     c(0x7e9464),
  pitch:     c(0x93a56d),
  urban:     c(0xc0b5a4),
  water:     c(0x6c93a8),

  road: {
    motorway: c(0x6a6660), trunk: c(0x6a6660), primary: c(0x6f6b65),
    secondary: c(0x736f69), tertiary: c(0x7a766f),
    residential: c(0x847f78), unclassified: c(0x847f78), service: c(0x8b8680),
  } as Record<string, THREE.Color>,

  buildingObserved:  c(0xb9ab9a),
  buildingEstimated: c(0xa8a29a),
  /** the reveal-estimated state: measured stays neutral, estimated goes amber so the ~92%
   *  of guessed heights in this box is impossible to miss */
  revealObserved:  c(0x9fb0a6),
  revealEstimated: c(0xc99a4e),

  rail:  c(0x57534e),
  metro: c(0x4a6e8a),

  stop:    c(0xe8e2d6),
  station: c(0x4a6e8a),
  bus:     c(0xd9552f),

  /** Traffic ramp is sequential in lightness, not green-to-red: it survives grayscale and
   *  colour-vision-deficiency review, which the PRD requires. */
  traffic: [c(0xf2e2ac), c(0xe6ab4c), c(0xcd6a33), c(0x9d3a22), c(0x6d1f14)],

  corridorIdle:   c(0x8e887f),
  corridorActive: c(0xf0e6d2),
} as const;

export function trafficColor(ratio: number): THREE.Color {
  const r = Math.min(Math.max(ratio, 0), 1);
  const ramp = PALETTE.traffic;
  const t = r * (ramp.length - 1);
  const i = Math.min(Math.floor(t), ramp.length - 2);
  return new THREE.Color().lerpColors(ramp[i], ramp[i + 1], t - i);
}

export const TRAFFIC_LABELS = ["Free flowing", "Light", "Moderate", "Heavy", "Severe"] as const;

export function trafficLabel(ratio: number): string {
  const i = Math.min(Math.floor(Math.min(Math.max(ratio, 0), 1) * TRAFFIC_LABELS.length),
                     TRAFFIC_LABELS.length - 1);
  return TRAFFIC_LABELS[i];
}
