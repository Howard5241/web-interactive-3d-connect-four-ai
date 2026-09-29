// models/Piece.fbx -> public/static/models/piece.bin: the bead mesh baked, centred, scaled to a unit
// bounding sphere and simplified, so the browser loads ~150 KB instead of a 26 MB FBX.
//
//   npm i --no-save three@0.160.0 meshoptimizer && node tools/build_piece.mjs
//
// Layout (little endian): u32 vertexCount, u32 indexCount, f32 silhouetteRadius,
// f32 position[3n], f32 normal[3n], f32 uv[2n], u16 index[indexCount].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'models', 'Piece.fbx');
const DST = path.join(ROOT, 'public', 'static', 'models', 'piece.bin');
const KEEP = 0.1;

// The FBX references its textures by absolute Windows path; only the geometry is wanted.
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
const warn = console.warn;
console.warn = () => {};
const buf = fs.readFileSync(SRC);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
console.warn = warn;
root.updateMatrixWorld(true);

let source = null;
root.traverse(o => { if (o.isMesh && !source) source = o; });
const geo = source.geometry.clone();
geo.applyMatrix4(source.matrixWorld);
geo.computeBoundingSphere();
const { center, radius } = geo.boundingSphere;
geo.translate(-center.x, -center.y, -center.z);
geo.scale(1 / radius, 1 / radius, 1 / radius);

const merged = mergeVertices(geo, 1e-6);
await MeshoptSimplifier.ready;
const positions = merged.attributes.position.array;
const target = Math.floor(merged.index.count * KEEP / 3) * 3;
const [simplified] = MeshoptSimplifier.simplify(
    new Uint32Array(merged.index.array), positions, 3, target, 0.01, ['LockBorder']);

const remap = new Map();
const indices = new Uint16Array(simplified.length);
simplified.forEach((v, i) => {
    if (!remap.has(v)) remap.set(v, remap.size);
    indices[i] = remap.get(v);
});
const n = remap.size;
const pick = (attr, size) => {
    const out = new Float32Array(n * size);
    for (const [from, to] of remap) {
        for (let k = 0; k < size; k++) out[to * size + k] = attr.array[from * size + k];
    }
    return out;
};
const pos = pick(merged.attributes.position, 3);
let silhouette = 0;
for (const v of pos) silhouette = Math.max(silhouette, Math.abs(v));

const header = new ArrayBuffer(12);
new Uint32Array(header, 0, 2).set([n, indices.length]);
new Float32Array(header, 8, 1)[0] = silhouette;
fs.writeFileSync(DST, Buffer.concat([
    header, pos.buffer, pick(merged.attributes.normal, 3).buffer, pick(merged.attributes.uv, 2).buffer, indices.buffer,
].map(b => Buffer.from(b))));
console.log(`${n} vertices, ${indices.length / 3} triangles -> ${DST} (${(fs.statSync(DST).size / 1024).toFixed(0)} KB)`);
