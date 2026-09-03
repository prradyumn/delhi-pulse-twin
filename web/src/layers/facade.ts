import * as THREE from "three";

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
         varying vec3 vFacadePos;
         varying vec3 vFacadeNrm;`,
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
