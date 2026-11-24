/**
 * Material for every vehicle, rider and debris mesh: a textured `MeshStandardMaterial` whose
 * shader is patched to repaint only the paint of a model.
 *
 * Kenney models sample one shared colour map, so a plain instance colour would tint glass, tyres
 * and lamps as well. Each vertex therefore carries a `paint` channel (0 fixed, 1 body paint,
 * 2 second paint) and each instance two colours:
 *
 * - `lookA` (vec4): body paint colour in `rgb`, overall shade in `a` (1 normal, below 1 for a
 *   wreck);
 * - `lookB` (vec3): second paint colour (a rider's helmet).
 *
 * A colour whose red channel is `KEEP_PAINT` (negative) keeps the model's own paint.
 *
 * On a painted texel the colour becomes the paint colour times the texel's brightness relative to
 * `PAINT_VALUE_REF`, which keeps the colour map's shading gradient. Fixed texels keep their colour.
 * Instanced meshes read the colours from instanced attributes, single meshes from uniforms.
 * `shadeTexel` is the same formula in JavaScript, used by the tests.
 */

import { Color, MeshStandardMaterial, Vector3, Vector4 } from 'three';

/** Red channel value of a look colour that keeps the model's own paint. */
export const KEEP_PAINT = -1;
/** Texel brightness (max channel, linear) that maps to the full paint colour. */
export const PAINT_VALUE_REF = 0.8;
/** Brightest a painted texel may get, relative to the paint colour. */
const PAINT_MAX = 1.15;

/** GLSL of the paint step, run after the colour map was applied to `diffuseColor`. */
const PAINT_GLSL = /* glsl */ `
  {
    float lookValue = clamp(max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b) / ${PAINT_VALUE_REF.toFixed(4)}, 0.0, ${PAINT_MAX.toFixed(4)});
    float paintA = step(0.5, vPaint) * (1.0 - step(1.5, vPaint)) * step(-0.5, vLookA.r);
    float paintB = step(1.5, vPaint) * step(-0.5, vLookB.r);
    diffuseColor.rgb = mix(diffuseColor.rgb, vLookA.rgb * lookValue, paintA);
    diffuseColor.rgb = mix(diffuseColor.rgb, vLookB * lookValue, paintB);
    diffuseColor.rgb *= vLookA.a;
  }
`;

/**
 * Pure mirror of the paint step for one texel (linear RGB).
 * @param {[number, number, number]} texel Colour map texel.
 * @param {number} paint Paint channel of the vertex.
 * @param {[number, number, number, number]} lookA Body paint colour and shade.
 * @param {[number, number, number]} lookB Second paint colour.
 * @returns {[number, number, number]} Shaded colour.
 */
export function shadeTexel(texel, paint, lookA, lookB) {
  const value = Math.min(PAINT_MAX, Math.max(0, Math.max(...texel) / PAINT_VALUE_REF));
  const a = paint >= 0.5 && paint < 1.5 && lookA[0] >= -0.5;
  const b = paint >= 1.5 && lookB[0] >= -0.5;
  /** @type {[number, number, number]} */
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const c = a ? lookA[i] * value : b ? lookB[i] * value : texel[i];
    out[i] = c * lookA[3];
  }
  return out;
}

/**
 * @typedef {object} LookUniforms
 * @property {{value: Vector4}} lookA Body paint and shade of a single (non-instanced) mesh.
 * @property {{value: Vector3}} lookB Second paint of a single mesh.
 */

/**
 * Creates the look material.
 * @param {object} [options] Options.
 * @param {import('three').Texture | null} [options.map] Colour map; may be set later.
 * @param {number} [options.roughness] Roughness.
 * @returns {MeshStandardMaterial & {userData: {look: LookUniforms}}} Material.
 */
export function createLookMaterial(options = {}) {
  const material = new MeshStandardMaterial({ map: options.map ?? null, roughness: options.roughness ?? 0.6, metalness: 0 });
  /** @type {LookUniforms} */
  const look = { lookA: { value: new Vector4(1, 1, 1, 1) }, lookB: { value: new Vector3(1, 1, 1) } };
  material.userData.look = look;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.lookA = look.lookA;
    shader.uniforms.lookB = look.lookB;
    shader.vertexShader = patchVertex(shader.vertexShader);
    shader.fragmentShader = patchFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'vehicle-look';
  return /** @type {MeshStandardMaterial & {userData: {look: LookUniforms}}} */ (material);
}

/**
 * Sets the look of a single mesh's material.
 * @param {MeshStandardMaterial} material Look material.
 * @param {number | null} paintA Body paint (sRGB hex), or null to keep the model's paint.
 * @param {number | null} paintB Second paint, or null.
 * @param {number} shade Overall shade.
 */
export function setSingleLook(material, paintA, paintB, shade) {
  const look = /** @type {LookUniforms | undefined} */ (material.userData.look);
  if (!look) throw new Error('Not a look material');
  const [ar, ag, ab] = lookRgb(paintA);
  const [br, bg, bb] = lookRgb(paintB);
  look.lookA.value.set(ar, ag, ab, shade);
  look.lookB.value.set(br, bg, bb);
}

const scratch = new Color();

/**
 * Linear RGB of a look colour.
 * @param {number | null} hex sRGB hex, or null to keep the model's paint.
 * @returns {[number, number, number]} Linear RGB, or the keep sentinel.
 */
export function lookRgb(hex) {
  if (hex === null) return [KEEP_PAINT, KEEP_PAINT, KEEP_PAINT];
  scratch.setHex(hex);
  return [scratch.r, scratch.g, scratch.b];
}

/**
 * Inserts text after an include line; throws when the include is missing, so a three.js upgrade
 * that renames a chunk fails loudly instead of drawing unpainted models.
 * @param {string} source Shader source.
 * @param {string} include Include name.
 * @param {string} text Text to insert.
 * @returns {string} Patched source.
 */
function after(source, include, text) {
  const tag = `#include <${include}>`;
  if (!source.includes(tag)) throw new Error(`Shader chunk ${include} not found`);
  return source.replace(tag, `${tag}\n${text}`);
}

/**
 * @param {string} source Vertex shader.
 * @returns {string} Patched vertex shader.
 */
export function patchVertex(source) {
  const decl = `attribute float paint;
varying float vPaint;
varying vec4 vLookA;
varying vec3 vLookB;
#ifdef USE_INSTANCING
attribute vec4 lookA;
attribute vec3 lookB;
#else
uniform vec4 lookA;
uniform vec3 lookB;
#endif`;
  return after(after(source, 'common', decl), 'begin_vertex', 'vPaint = paint;\nvLookA = lookA;\nvLookB = lookB;');
}

/**
 * @param {string} source Fragment shader.
 * @returns {string} Patched fragment shader.
 */
export function patchFragment(source) {
  return after(after(source, 'common', 'varying float vPaint;\nvarying vec4 vLookA;\nvarying vec3 vLookB;'), 'map_fragment', PAINT_GLSL);
}
