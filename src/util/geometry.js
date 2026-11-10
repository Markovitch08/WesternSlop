import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Box whose UVs are in metres / `tile`, so a repeating texture keeps the same
 * scale on every face regardless of box size.
 */
export function worldBox(w, h, d, tile = 2) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  // Face order: +x, -x, +y, -y, +z, -z; 4 vertices each.
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * su) / tile, (uv.getY(i) * sv) / tile);
    }
  }
  return geo;
}

/** Translate/rotate a geometry in place and return it (for merge lists). */
export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  geo.translate(x, y, z);
  return geo;
}

/** Paint a flat vertex colour onto a geometry (for single-draw-call props). */
export function tint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Merge geometries after making their attribute sets compatible. */
export function merge(geos) {
  const keep = ['position', 'normal', 'uv', 'color'].filter((a) => geos.every((g) => g.attributes[a]));
  for (const g of geos) {
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
  }
  const indexed = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(indexed, false);
}

let barrelGeo = null;
/** Wooden barrel with iron hoops, vertex-coloured: one draw call. Base at y=0. */
export function barrelGeometry() {
  if (barrelGeo) return barrelGeo;
  const profile = [];
  const H = 0.85;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    profile.push(new THREE.Vector2(0.26 + Math.sin(t * Math.PI) * 0.04, t * H));
  }
  const body = tint(new THREE.LatheGeometry(profile, 16), 0x7a4a26);
  const lid = tint(place(new THREE.CircleGeometry(0.255, 16), 0, H, 0, -Math.PI / 2), 0x6a3f20);
  const hoops = [0.12, 0.3, 0.55, 0.73].map((y) => {
    const r = 0.26 + Math.sin((y / H) * Math.PI) * 0.04 + 0.004;
    return tint(place(new THREE.CylinderGeometry(r, r, 0.035, 16, 1, true), 0, y, 0), 0x2c2a28);
  });
  for (const g of [body, lid, ...hoops]) g.deleteAttribute('uv');
  barrelGeo = merge([body, lid, ...hoops]);
  barrelGeo.computeBoundingSphere();
  return barrelGeo;
}
