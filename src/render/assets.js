/**
 * Asset access for the renderer: public URLs, sign textures and GLB models. Every loader fails
 * loudly (console.error with the URL) and leaves the caller's fallback in place.
 */

import { CanvasTexture, SRGBColorSpace, TextureLoader } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { SIGN_TEXTURE_PX, signArt, signArtPath, signValueText } from './sign-art.js';

/**
 * URL of a file under `public/`, honouring Vite's base path.
 * @param {string} path Path relative to `public/`, e.g. `signs/P.127.svg`.
 * @returns {string} URL.
 */
export function assetUrl(path) {
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}${path}`;
}

/** Whether a DOM is present (false under Node tests). */
export const HAS_DOM = typeof document !== 'undefined';

/**
 * Loads an image element.
 * @param {string} url URL.
 * @returns {Promise<HTMLImageElement>} Loaded image.
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image ${url}`));
    img.src = url;
  });
}

/**
 * Creates the texture of one sign: the SVG drawn on a canvas, plus the map value for signs that
 * carry one (P.127). The texture is blank until the image loads.
 * @param {string} code Sign code.
 * @param {number | undefined} value Map sign value.
 * @returns {CanvasTexture | null} Texture, or null without a DOM.
 */
export function createSignTexture(code, value) {
  if (!HAS_DOM) return null;
  const art = signArt(code);
  const canvas = document.createElement('canvas');
  const scale = SIGN_TEXTURE_PX / Math.max(art.widthM, art.heightM);
  canvas.width = Math.round(art.widthM * scale);
  canvas.height = Math.round(art.heightM * scale);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const url = assetUrl(signArtPath(code));
  loadImage(url)
    .then((img) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const text = signValueText(code, value);
      if (text && art.value) {
        const size = canvas.height * (text.length >= 3 ? 0.3 : 0.4);
        ctx.fillStyle = art.value.color;
        ctx.font = `bold ${Math.round(size)}px Arial, Helvetica, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.05);
        const band = art.value.bandOver;
        if (band) {
          const k = canvas.width / band.viewBox;
          ctx.strokeStyle = band.color;
          ctx.lineWidth = band.strokeWidth * k;
          ctx.beginPath();
          for (const [x1, y1, x2, y2] of band.lines) {
            ctx.moveTo(x1 * k, y1 * k);
            ctx.lineTo(x2 * k, y2 * k);
          }
          ctx.stroke();
        }
      }
      texture.needsUpdate = true;
    })
    .catch((err) => {
      console.error(`Sign ${code}: ${err instanceof Error ? err.message : String(err)}`);
    });
  return texture;
}

/**
 * A glTF loader that also reads meshopt-compressed geometry (`EXT_meshopt_compression`, used by
 * the Tripo models to stay inside the model payload budget).
 * @returns {GLTFLoader} Loader.
 */
export function createGltfLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

/** @type {Map<string, Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>>} */
const modelCache = new Map();
/** @type {Map<string, Promise<import('three').Texture>>} */
const textureCache = new Map();

/**
 * Loads a colour-map texture once per URL, set up like the textures of Kenney GLBs (sRGB, not
 * flipped), so procedural models can share a GLB's colour map.
 * @param {string} path Path relative to `public/`.
 * @returns {Promise<import('three').Texture>} Texture.
 */
export function loadTexture(path) {
  const url = assetUrl(path);
  let pending = textureCache.get(url);
  if (!pending) {
    pending = new TextureLoader().loadAsync(url).then((texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.flipY = false;
      texture.needsUpdate = true;
      return texture;
    });
    const entry = pending;
    entry.catch(() => {
      if (textureCache.get(url) === entry) textureCache.delete(url);
    });
    textureCache.set(url, pending);
  }
  return pending;
}

/**
 * Loads a GLB once per URL. Rejects on a network error, a non-OK status or a file that is not a
 * glTF binary (an HTML fallback page served with status 200 fails the magic check).
 * @param {string} path Path relative to `public/`.
 * @returns {Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>} Parsed model.
 */
export function loadModel(path) {
  const url = assetUrl(path);
  let pending = modelCache.get(url);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = await res.arrayBuffer();
      const magic = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(4, data.byteLength)));
      if (magic !== 'glTF') throw new Error(`${url} is not a GLB file`);
      const resourcePath = url.slice(0, url.lastIndexOf('/') + 1);
      return createGltfLoader().parseAsync(data, resourcePath);
    })();
    // A failed load is not cached, so a later renderer retries it.
    const entry = pending;
    entry.catch(() => {
      if (modelCache.get(url) === entry) modelCache.delete(url);
    });
    modelCache.set(url, pending);
  }
  return pending;
}

/**
 * Frees the GPU resources of every loaded model and texture and empties the caches. Views clone
 * loaded scenes with shared geometry and materials, so call this only once no view uses them.
 * @returns {Promise<void>} Resolves when every settled model has been released.
 */
export async function releaseModels() {
  const pending = [...modelCache.values()];
  modelCache.clear();
  const textures = [...textureCache.values()];
  textureCache.clear();
  for (const t of await Promise.allSettled(textures)) if (t.status === 'fulfilled') t.value.dispose();
  const results = await Promise.allSettled(pending);
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    r.value.scene.traverse((o) => {
      const mesh = /** @type {import('three').Mesh} */ (o);
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of materials) {
        for (const value of Object.values(m)) if (value && value.isTexture) value.dispose();
        m.dispose();
      }
    });
  }
}
