import * as THREE from "three";

/**
 * Shared across every facade material, so one write lights the whole city.
 *
 * `uNight` runs 0 (broad day) to 1 (dark). The stage already computes sun elevation for the time
 * control, so windows come on because the sun went down — the clock drives it, not a separate
 * switch.
 */
export const FACADE_UNIFORMS = { uNight: { value: 0 } };

/**
 * Procedural facade detail for extruded building stock.
 *
 * There are no textures in this project by design — the data register forbids redistributing
 * landmark imagery, and a 3,203-building texture atlas would blow the transfer budget the whole
 * pipeline was tuned around. So the storey lines, window rhythm and ground-floor plinth are
 * generated in the shader from world position, which costs no bytes and no draw calls.
 *
 * It *modulates* `diffuseColor`, never replaces it, so everything the vertex colours encode still
 * shows through: the observed/estimated reveal, corridor traffic state, selection highlight.
 */
export function applyFacadeDetail(
  mat: THREE.MeshStandardMaterial,
  opts: { storeyM?: number; bayM?: number; strength?: number } = {},
) {
  const storey = opts.storeyM ?? 3.5;
  const bay = opts.bayM ?? 4.2;
  const strength = opts.strength ?? 1.0;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStorey = { value: storey };
    shader.uniforms.uBay = { value: bay };
    shader.uniforms.uStrength = { value: strength };
    // shared by reference, not copied: updating FACADE_UNIFORMS reaches every material at once
    shader.uniforms.uNight = FACADE_UNIFORMS.uNight;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vFacadePos;
         varying vec3 vFacadeNrm;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
         vFacadeNrm = normalize(mat3(modelMatrix) * objectNormal);`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vFacadePos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uStorey; uniform float uBay; uniform float uStrength;
         uniform float uNight;
         varying vec3 vFacadePos;
         varying vec3 vFacadeNrm;
         float dptWinHash(vec2 c) {
           return fract(sin(dot(c, vec2(41.7, 289.1))) * 24634.6345);
         }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         {
           float up = abs(vFacadeNrm.y);
           float wall = 1.0 - smoothstep(0.35, 0.75, up);   // 1 on walls, 0 on roofs

           // Fade the pattern out with distance or it turns into moire on the far side of a 4 km box.
           float dist = length(vFacadePos - cameraPosition);
           float detail = (1.0 - smoothstep(900.0, 2600.0, dist)) * uStrength;

           // storey lines: a soft dark band once per floor height
           float floors = 1.0 - smoothstep(0.03, 0.16, abs(fract(vFacadePos.y / uStorey) - 0.5));

           // window bays: step along whichever horizontal axis the wall actually faces
           float u = abs(vFacadeNrm.x) > abs(vFacadeNrm.z) ? vFacadePos.z : vFacadePos.x;
           float bays = 1.0 - smoothstep(0.03, 0.20, abs(fract(u / uBay) - 0.5));

           float openings = clamp(floors * 0.62 + bays * 0.34, 0.0, 1.0) * wall * detail;

           // ground floor reads darker: shopfronts, arcades, and plain contact with the street
           float plinth = (1.0 - smoothstep(0.0, 4.2, vFacadePos.y)) * wall;

           // very slight vertical lift so tall blocks do not read as flat slabs
           float lift = clamp(vFacadePos.y / 70.0, 0.0, 1.0) * 0.06 * wall;

           diffuseColor.rgb *= (1.0 - openings * 0.26) * (1.0 - plinth * 0.20) + lift;

           // Roofs are not painted plaster. Pull them toward a grey gravel/concrete tone and add
           // a little grain, so the skyline stops looking like extruded swatches from above.
           float roof = smoothstep(0.55, 0.9, up);
           if (roof > 0.001) {
             float g = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
             vec3 gravel = mix(vec3(g), vec3(g) * vec3(1.02, 1.0, 0.96), 0.5) * 0.9;
             float speck = fract(sin(dot(floor(vFacadePos.xz / 1.6), vec2(12.99, 78.23))) * 43758.55);
             gravel *= 0.93 + speck * 0.14;
             diffuseColor.rgb = mix(diffuseColor.rgb, gravel, roof * 0.62 * max(detail, 0.35));
           }
           diffuseColor.rgb *= 1.0 + up * 0.04;             // roofs catch a touch more sky
         }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         if (uNight > 0.01) {
           float upN = abs(vFacadeNrm.y);
           float wallN = 1.0 - smoothstep(0.35, 0.75, upN);
           float uN = abs(vFacadeNrm.x) > abs(vFacadeNrm.z) ? vFacadePos.z : vFacadePos.x;
           // one cell per window bay per storey; a hash decides which are occupied, so the
           // pattern is scattered but identical on every reload
           vec2 cell = vec2(floor(uN / uBay), floor(vFacadePos.y / uStorey));
           float occupied = step(dptWinHash(cell), 0.42);
           // the pane itself, so light comes from a window rather than the whole wall
           float fy = abs(fract(vFacadePos.y / uStorey) - 0.62);
           float fx = abs(fract(uN / uBay) - 0.5);
           float pane = (1.0 - smoothstep(0.10, 0.26, fy)) * (1.0 - smoothstep(0.14, 0.32, fx));
           // ground floors stay lit later than upper storeys: shopfronts, not flats
           float lowFloor = 1.0 - smoothstep(0.0, 12.0, vFacadePos.y);
           float warm = 0.55 + 0.45 * dptWinHash(cell + 7.3);
           vec3 glow = vec3(1.0, 0.78, 0.46) * warm;
           float amount = pane * occupied * wallN * uNight * (0.62 + lowFloor * 0.5);
           float dist2 = length(vFacadePos - cameraPosition);
           amount *= 1.0 - smoothstep(1200.0, 3000.0, dist2);
           totalEmissiveRadiance += glow * amount * 2.4;
         }`,
      );
  };
  mat.customProgramCacheKey = () => `facade-${storey}-${bay}-${strength}`;
  return mat;
}

/**
 * Ground cover gets a low-frequency tonal wobble for the same reason: 489 flat polygons in four
 * colours read as vector art, and a lawn is not one colour.
 */
export function applyGroundVariation(mat: THREE.MeshStandardMaterial, amount = 0.06) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAmount = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n varying vec3 vGroundPos;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\n vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>
         uniform float uAmount;
         varying vec3 vGroundPos;
         // cheap value noise; no texture fetch, no assets
         float dptHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float dptNoise(vec2 p) {
           vec2 i = floor(p), f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           return mix(mix(dptHash(i), dptHash(i + vec2(1, 0)), u.x),
                      mix(dptHash(i + vec2(0, 1)), dptHash(i + vec2(1, 1)), u.x), u.y);
         }`)
      .replace("#include <color_fragment>",
        `#include <color_fragment>
         {
           vec2 q = vGroundPos.xz;
           float n = dptNoise(q / 46.0) * 0.62 + dptNoise(q / 13.0) * 0.38;
           float dist = length(vGroundPos - cameraPosition);
           float detail = 1.0 - smoothstep(1400.0, 3200.0, dist);
           diffuseColor.rgb *= 1.0 + (n - 0.5) * 2.0 * uAmount * detail;
         }`);
  };
  mat.customProgramCacheKey = () => `ground-var-${amount}`;
  return mat;
}

/**
 * Street lighting. At night the sky stops being the light source, so without this the roads go
 * black and the city becomes a field of floating windows. Delhi also has enormous skyglow, so a
 * lit road surface is closer to the truth than a dark one.
 *
 * A warm emissive on the carriageway, pooled along its length so it reads as lamps rather than a
 * uniformly glowing strip.
 */
export function applyStreetLighting(mat: THREE.MeshStandardMaterial, spacing = 28) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = FACADE_UNIFORMS.uNight;
    shader.uniforms.uLampSpacing = { value: spacing };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n varying vec3 vLitPos;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\n vLitPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>
         uniform float uNight; uniform float uLampSpacing;
         varying vec3 vLitPos;`)
      .replace("#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         if (uNight > 0.01) {
           // pools of light along whichever axis the road mostly runs
           float along = max(abs(vLitPos.x), abs(vLitPos.z));
           float pool = 0.45 + 0.55 * pow(
             1.0 - smoothstep(0.0, 0.5, abs(fract(along / uLampSpacing) - 0.5)), 2.0);
           float fade = 1.0 - smoothstep(900.0, 2400.0, length(vLitPos - cameraPosition));
           totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * uNight * pool * fade * 0.22;
         }`);
  };
  mat.customProgramCacheKey = () => `streetlight-${spacing}`;
  return mat;
}

/**
 * Baked city ambient occlusion.
 *
 * The AO that screen-space GTAO could not afford (measured ~18 ms of a 16.7 ms budget, and it
 * doubled submitted geometry). This is the same information rendered once in Blender as top-down
 * sky visibility, sampled here as a planar texture: **free every frame, and better quality**,
 * because a bake is not limited to what happens to be on screen.
 *
 * Applied only to horizontal surfaces — ground, roads, footways, plazas. Deliberately not to
 * walls: the bake renders occluders black, so a UV taken at a wall's base lands on that building's
 * own dark roof and the wall would go nearly black.
 *
 * UVs come straight from world position. The bake is a square orthographic render centred on the
 * study box, and the box is centred on the origin, so:
 *
 *     u =  x / orthoScale + 0.5
 *     v = -z / orthoScale + 0.5
 */
export function applyBakedAO(
  mat: THREE.MeshStandardMaterial,
  aoMap: THREE.Texture,
  orthoScale: number,
  strength = 0.85,
) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uCityAO = { value: aoMap };
    shader.uniforms.uAOOrtho = { value: orthoScale };
    shader.uniforms.uAOStrength = { value: strength };

    if (!/varying vec3 vAOPos;/.test(shader.vertexShader)) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\n varying vec3 vAOPos;")
        .replace("#include <begin_vertex>",
          "#include <begin_vertex>\n vAOPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    }
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>
         uniform sampler2D uCityAO;
         uniform float uAOOrtho;
         uniform float uAOStrength;
         varying vec3 vAOPos;`)
      .replace("#include <color_fragment>",
        `#include <color_fragment>
         {
           vec2 aoUv = vec2(vAOPos.x / uAOOrtho + 0.5, -vAOPos.z / uAOOrtho + 0.5);
           if (aoUv.x > 0.0 && aoUv.x < 1.0 && aoUv.y > 0.0 && aoUv.y < 1.0) {
             float ao = texture2D(uCityAO, aoUv).r;
             // A floor of 0.35 keeps a deep courtyard readable rather than crushed to black —
             // the bake bottoms out at 0.12 where a building occludes the ground entirely.
             ao = mix(1.0, max(ao, 0.35), uAOStrength);
             diffuseColor.rgb *= ao;
           }
         }`);
  };
  const key = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${key ? key() : "std"}|cityao-${strength}`;
  return mat;
}

/** OSM `building=*` -> atlas cell. This is the point of the atlas: the texture is keyed to real
 *  data, so a glass office and a sandstone ministry look different because they *are* different,
 *  not because variety looks nice. */
export function atlasCellFor(buildingClass: string): number {
  switch (buildingClass) {
    case "commercial": case "office": case "industrial": case "warehouse":
      return 0;
    case "government": case "public": case "civic": case "civil": case "college":
    case "university": case "school": case "hospital": case "museum": case "train_station":
    case "temple": case "mosque": case "church": case "cathedral": case "shrine":
      return 1;
    case "retail": case "supermarket": case "shop": case "kiosk": case "mall":
      return 3;
    default:
      // `building=yes` is 84% of this box, so the default has to be the ordinary case:
      // plaster with punched windows, which is what most of Lutyens' Delhi actually is
      return 2;
  }
}

export interface FacadeMaps {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  /** number of cells across the strip */
  cells: number;
}

/**
 * Textured facades from the generated strip atlas.
 *
 * Replaces the procedural window pattern with real material: window recesses that light correctly
 * via the normal map, glass that is smooth where plaster is coarse via the roughness map, and
 * staining below the sills. The class comes from a vertex attribute, so **one material and one
 * draw call still covers every building** — the alternative, a material per class, would have
 * multiplied the draw calls this project just spent a day reducing.
 *
 * UVs are world-space: u from whichever horizontal axis the wall faces, v from height. So the
 * texture is tied to real metres — a storey is a storey — rather than to an arbitrary unwrap.
 */
export function applyFacadeTextures(
  mat: THREE.MeshStandardMaterial,
  maps: FacadeMaps,
  opts: { storeyM?: number; bayM?: number } = {},
) {
  const storey = opts.storeyM ?? 3.5;
  const bay = opts.bayM ?? 4.2;
  const prev = mat.onBeforeCompile;
  // three only generates the tangent/normal plumbing if the material declares a normal map
  mat.normalMap = maps.normal;
  mat.normalScale = new THREE.Vector2(1.1, 1.1);

  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uFacAlbedo = { value: maps.albedo };
    shader.uniforms.uFacRough = { value: maps.roughness };
    shader.uniforms.uFacNormal = { value: maps.normal };
    shader.uniforms.uFacCells = { value: maps.cells };
    shader.uniforms.uFacStorey = { value: storey };
    shader.uniforms.uFacBay = { value: bay };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>",
        `#include <common>
         attribute float aClass;
         attribute float aPhase;
         varying float vClass;
         varying float vPhase;`)
      .replace("#include <begin_vertex>",
        `#include <begin_vertex>
         vClass = aClass;
         vPhase = aPhase;`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        `#include <common>
         uniform sampler2D uFacAlbedo;
         uniform sampler2D uFacRough;
         uniform sampler2D uFacNormal;
         uniform float uFacCells;
         uniform float uFacStorey;
         uniform float uFacBay;
         varying float vClass;
         varying float vPhase;

         // Atlas UV for a strip: the class picks a cell, the fractional part walks within it.
         // Clamped a texel inside the cell so bilinear filtering cannot bleed the neighbour in.
         vec2 dptAtlasUv(float cellIx, vec2 local) {
           float inv = 1.0 / uFacCells;
           float pad = 0.5 * inv / 256.0;
           float u = (cellIx + clamp(fract(local.x), pad, 1.0 - pad)) * inv;
           return vec2(u, clamp(fract(local.y), 0.0, 1.0));
         }`)
      .replace("#include <color_fragment>",
        `#include <color_fragment>
         {
           float upF = abs(vFacadeNrm.y);
           float wallF = 1.0 - smoothstep(0.35, 0.75, upF);
           if (wallF > 0.01) {
             float axis = abs(vFacadeNrm.x) > abs(vFacadeNrm.z) ? vFacadePos.z : vFacadePos.x;
             vec2 local = vec2(axis / uFacBay + vPhase, vFacadePos.y / uFacStorey);
             vec2 auv = dptAtlasUv(vClass, local);
             vec3 tex = texture2D(uFacAlbedo, auv).rgb;
             // modulate rather than replace: the vertex colour still carries the reveal state,
             // the selection highlight and the per-building tone
             float dist = length(vFacadePos - cameraPosition);
             float amt = wallF * (1.0 - smoothstep(1100.0, 2800.0, dist));
             diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * tex * 1.55, amt);
           }
         }`)
      .replace("#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         {
           float upR = abs(vFacadeNrm.y);
           float wallR = 1.0 - smoothstep(0.35, 0.75, upR);
           if (wallR > 0.01) {
             float axisR = abs(vFacadeNrm.x) > abs(vFacadeNrm.z) ? vFacadePos.z : vFacadePos.x;
             vec2 lr = vec2(axisR / uFacBay + vPhase, vFacadePos.y / uFacStorey);
             float rr = texture2D(uFacRough, dptAtlasUv(vClass, lr)).r;
             roughnessFactor = mix(roughnessFactor, rr, wallR);
           }
         }`);
  };
  const key = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${key ? key() : "std"}|factex`;
  return mat;
}
