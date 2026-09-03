import * as THREE from "three";

export type XZ = [number, number];

/**
 * Winding is not cosmetic here — it decides whether a face is visible at all.
 *
 * All of this geometry is built in the XZ plane. For a triangle to face +Y (up) in Three's
 * right-handed space, its vertices must run *clockwise* when plotted with x right and z up,
 * i.e. with a NEGATIVE shoelace area. Worked through: ring (0,0) → (0,1) → (1,0) has shoelace
 * −1, and (b−a)×(c−a) = (0,0,1)×(1,0,0) = (0,1,0) — up. OSM rings arrive in either winding, so
 * every ring is normalised here once, and then roofs face up and walls face outward for free.
 */
function signedArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Normalise to negative signed area → up-facing roofs, outward-facing walls. */
export function orient(ring: XZ[]): XZ[] {
  return signedArea(ring) > 0 ? [...ring].reverse() : ring;
}

/** Triangulate a footprint ring into local index triples. THREE.ShapeUtils is earcut, and it
 *  preserves the input ring's winding, which is why `orient` runs first. */
function fanIndices(ring: XZ[]): number[][] {
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  try {
    return THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return [];
  }
}

/** Normals are computed from the geometry, never hand-authored: a hand-written normal that
 *  disagrees with the winding lights a surface from the wrong side, and every vertex here is
 *  unshared, so computeVertexNormals yields exact flat normals. */
function finish(pos: number[], col: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export interface Built {
  geometry: THREE.BufferGeometry;
  /** vertex index -> feature index, so a raycast hit resolves to a real entity id */
  vertexFeature: Uint32Array;
  triangles: number;
}

/**
 * Ordinary buildings are extruded here rather than baked in Blender. Spike-0 measured the baked
 * GLB at 266 KB gzip against 175 KB for the footprints — and the footprints ship anyway, because
 * every building must be inspectable. See docs/06-SPIKE-0-BAKEOFF.md.
 */
export function extrudeFootprints(
  feats: { r: XZ[]; h: number; m: 0 | 1 }[],
  opts: { colorFor: (f: { h: number; m: 0 | 1 }, i: number) => THREE.Color },
): Built {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const vfeat: number[] = [];
  const c = new THREE.Color();

  feats.forEach((f, fi) => {
    const ring = orient(f.r);
    const n = ring.length;
    if (n < 3) return;
    const h = Math.max(f.h, 2);
    const roof = fanIndices(ring);
    if (!roof.length) return;
    c.copy(opts.colorFor(f, fi));

    // --- walls: one quad per edge. With the ring oriented, (v0,v1,v2)/(v0,v2,v3) faces outward.
    for (let i = 0; i < n; i++) {
      const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % n];
      const base = pos.length / 3;
      const quad: [number, number, number][] = [
        [x0, 0, z0], [x1, 0, z1], [x1, h, z1], [x0, h, z0],
      ];
      for (let k = 0; k < 4; k++) {
        const [px, py, pz] = quad[k];
        pos.push(px, py, pz);
        // bases sit darker, which reads as a contact shadow without costing a shadow map
        const shade = py === 0 ? 0.78 : 1.0;
        col.push(c.r * shade, c.g * shade, c.b * shade);
        vfeat.push(fi);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    // --- roof
    const rbase = pos.length / 3;
    for (const [x, z] of ring) {
      pos.push(x, h, z);
      col.push(Math.min(c.r * 1.06, 1), Math.min(c.g * 1.06, 1), Math.min(c.b * 1.05, 1));
      vfeat.push(fi);
    }
    for (const t of roof) idx.push(rbase + t[0], rbase + t[1], rbase + t[2]);
  });

  return { geometry: finish(pos, col, idx), vertexFeature: new Uint32Array(vfeat),
           triangles: idx.length / 3 };
}

/**
 * Flat ribbon along a polyline. Roads are runtime geometry precisely because their colour is the
 * analytical payload: traffic state, corridor highlight and scenario deltas all repaint vertices.
 */
export function ribbons(
  lines: { p: XZ[]; width: number; y: number; color: THREE.Color }[],
): Built {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const vfeat: number[] = [];

  lines.forEach((ln, li) => {
    const p = ln.p;
    if (p.length < 2) return;
    const half = ln.width / 2;
    const left: XZ[] = [], right: XZ[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(i - 1, 0)], b = p[Math.min(i + 1, p.length - 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      left.push([p[i][0] + dz * half, p[i][1] - dx * half]);
      right.push([p[i][0] - dz * half, p[i][1] + dx * half]);
    }
    const base = pos.length / 3;
    for (let i = 0; i < p.length; i++) {
      pos.push(left[i][0], ln.y, left[i][1]);
      col.push(ln.color.r, ln.color.g, ln.color.b); vfeat.push(li);
      pos.push(right[i][0], ln.y, right[i][1]);
      col.push(ln.color.r, ln.color.g, ln.color.b); vfeat.push(li);
    }
    // (left_i, right_i, left_i+1) and (right_i, right_i+1, left_i+1) both face +Y — verified by
    // hand for a +X-running segment. The obvious-looking alternative ordering faces the ground,
    // which renders nothing at all under front-face culling.
    for (let i = 0; i < p.length - 1; i++) {
      const l0 = base + i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
      idx.push(l0, r0, l1, r0, r1, l1);
    }
  });

  return { geometry: finish(pos, col, idx), vertexFeature: new Uint32Array(vfeat),
           triangles: idx.length / 3 };
}

/** Flat filled polygons (ground cover, water areas), merged into one geometry. */
export function fills(
  polys: { r: XZ[]; y: number; color: THREE.Color }[],
): Built {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const vfeat: number[] = [];
  polys.forEach((pl, pi) => {
    const ring = orient(pl.r);
    const tris = fanIndices(ring);
    if (!tris.length) return;
    const base = pos.length / 3;
    for (const [x, z] of ring) {
      pos.push(x, pl.y, z);
      col.push(pl.color.r, pl.color.g, pl.color.b); vfeat.push(pi);
    }
    for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
  });
  return { geometry: finish(pos, col, idx), vertexFeature: new Uint32Array(vfeat),
           triangles: idx.length / 3 };
}

/** Repaint a vertex-coloured geometry per feature, without rebuilding it. */
export function repaint(
  g: THREE.BufferGeometry, vertexFeature: Uint32Array,
  colorFor: (featureIndex: number) => THREE.Color | null,
) {
  const attr = g.getAttribute("color") as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  const cache = new Map<number, THREE.Color | null>();
  for (let v = 0; v < vertexFeature.length; v++) {
    const fi = vertexFeature[v];
    let c = cache.get(fi);
    if (c === undefined) { c = colorFor(fi); cache.set(fi, c); }
    if (!c) continue;
    arr[v * 3] = c.r; arr[v * 3 + 1] = c.g; arr[v * 3 + 2] = c.b;
  }
  attr.needsUpdate = true;
}
