import * as THREE from 'three';
import { Duelist } from './Duelist.js';
import { Gong } from './Gong.js';
import { BottleGroup } from './BottleGroup.js';
import { ShardFX } from '../fx/ShardFX.js';
import { FloatingText } from '../ui/FloatingText.js';
import { Scoreboard } from '../ui/Scoreboard.js';
import { plankTexture } from '../util/canvasTextures.js';
import { worldBox, barrelGeometry } from '../util/geometry.js';

/** Where the player stands; targets turn to face this point. */
const FIRING_LINE = new THREE.Vector3(0, 1.5, 0);
const BELL_POSITION = new THREE.Vector3(0, 1.0, -0.8);

const DUELIST_SPOTS = [[-3, -8], [-0.8, -11.5], [1.6, -9], [3.8, -14]];
const GONG_SPOTS = [[-5.5, -13, 0.25], [5.5, -18, 0.2], [0.6, -24, 0.15]];

const DUEL_GAP = [1.5, 4.0]; // random pause between duels, seconds

const SCORE_COLORS = { head: '#ff6b4a', heart: '#ffd36b', center: '#ffd36b' };

/**
 * Owns every target, the duel scheduler, scoring and the score UI.
 *
 * Scoring: each target returns a zone, a precision (0..1) and base points.
 * Points = base × distance factor (1 + d/15), with gongs also scaled by
 * precision, plus a reaction bonus for duels: up to +100 for a hit within
 * 0.35 s of the pop-up, falling to 0 at 2 s.
 */
export class TargetManager extends THREE.EventDispatcher {
  /**
   * @param {THREE.Scene} scene
   * @param {{ sfx: import('../audio/SoundFX.js').SoundFX, camera: THREE.Camera,
   *   physics: import('../physics/PhysicsWorld.js').PhysicsWorld }} deps
   */
  constructor(scene, { sfx, camera, physics }) {
    super();
    this.physics = physics;
    this.scene = scene;
    this.sfx = sfx;
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'targets';
    scene.add(this.root);

    this.shards = new ShardFX(scene);
    this.text = new FloatingText(scene);
    this.scoreboard = new Scoreboard(scene);

    this.staticColliders = [...this.scoreboard.colliders];

    // --- Pop-up duelists ---
    this.duelists = DUELIST_SPOTS.map(([x, z]) => {
      const d = new Duelist(new THREE.Vector3(x, 0, z), FIRING_LINE);
      d.onResolved = (duelist, outcome) => this.#onDuelResolved(duelist, outcome);
      this.root.add(d.object);
      return d;
    });

    // --- Hanging steel gongs ---
    this.gongs = GONG_SPOTS.map(([x, z, r]) => {
      const g = new Gong(new THREE.Vector3(x, 0, z), r, FIRING_LINE);
      this.root.add(g.object);
      return g;
    });

    // --- Bottles: a near row on a plank across two barrels, a far trio on a crate ---
    const wood = new THREE.MeshStandardMaterial({ map: plankTexture('#7a5232', 6), roughness: 0.85 });
    const barrelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.propMeshes = [];
    const prop = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.surface = 'wood';
      this.root.add(mesh);
      this.staticColliders.push(mesh);
      this.propMeshes.push(mesh);
      return mesh;
    };
    prop(new THREE.Mesh(barrelGeometry(), barrelMat), 1.85, 0, -5.5);
    prop(new THREE.Mesh(barrelGeometry(), barrelMat), 3.15, 0, -5.5);
    prop(new THREE.Mesh(worldBox(2.1, 0.05, 0.3, 1), wood), 2.5, 0.875, -5.5);
    prop(new THREE.Mesh(worldBox(0.6, 0.6, 0.6, 1), wood), -2.4, 0.3, -19);

    this.bottleGroups = [
      new BottleGroup(this.root, [0, 1, 2, 3, 4, 5].map((i) => new THREE.Vector3(1.7 + i * 0.32, 0.9, -5.5))),
      new BottleGroup(this.root, [-0.2, 0, 0.2].map((dx) => new THREE.Vector3(-2.4 + dx, 0.6, -19))),
    ];
    for (const g of this.bottleGroups) {
      g.onShatter = (point, color, dir, i) => {
        this.shards.burst(point, color, 16, dir, { speed: 2.2, size: 1, life: 2.5 });
        this.sfx.glassShatter(point);
        if (g.bodies) g.bodies[i].collisionResponse = false; // the gun now passes through
      };
    }

    // --- Reset plate: small red steel disc beside the scoreboard ---
    this.resetPlate = this.#buildResetPlate(new THREE.Vector3(-1.6, 0, -4.5));

    for (const t of [...this.duelists, ...this.gongs]) this.staticColliders.push(...t.staticColliders);
    this.targets = [...this.duelists, ...this.gongs, ...this.bottleGroups, this.resetPlate];

    this.#registerPhysics();

    this.time = 0;
    this.duelEnabled = true;
    this.duel = { phase: 'wait', timer: 3, active: null, last: null };
    this._colliders = [];
    this.resetStats();
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------
  resetStats() {
    this.stats = {
      points: 0, shots: 0, hits: 0, headshots: 0,
      duelsWon: 0, duelsMissed: 0,
      reactions: [], bestReaction: null, avgReaction: null,
      last: null,
    };
    this.dirty = true;
  }

  /** Every mesh a bullet can hit, right now (broken bottles drop out). */
  get colliders() {
    const list = this._colliders;
    list.length = 0;
    list.push(...this.staticColliders);
    for (const t of this.targets) list.push(...t.activeColliders());
    return list;
  }

  /**
   * Resolve a revolver shot. Every shot counts toward accuracy.
   * @param {{ origin: THREE.Vector3, direction: THREE.Vector3, hit: THREE.Intersection|null }} shot
   * @returns {object|null} hit report when a live target was hit
   */
  handleShot(shot) {
    this.stats.shots++;
    this.dirty = true;
    const hit = shot.hit;
    if (!hit) return null;

    const target = hit.object.userData.target;
    const result = target ? target.onHit(hit, shot, this.time) : null;
    if (result) return this.#score(result, hit, shot, target);

    // Plain surface (or a target that is not live, like a fallen duelist).
    const surface = hit.object.userData.surface ?? 'sand';
    this.sfx.surfaceHit(surface, hit.point);
    if (surface === 'wood') this.shards.burst(hit.point, 0x9a6a3e, 5, null, { speed: 1.4, size: 0.6, life: 1.2 });
    return null;
  }

  #score(result, hit, shot, target) {
    if (result.type === 'reset') {
      this.resetStats();
      this.sfx.steelPing(hit.point, 0.12);
      this.text.spawn(hit.point, ['RESET', 'scores cleared'], '#ff8a6b');
      const report = { type: 'reset' };
      this.dispatchEvent({ type: 'hit', report });
      return report;
    }

    const distance = shot.origin.distanceTo(hit.point);
    const distFactor = 1 + distance / 15;
    const precisionFactor = result.type === 'gong' ? 0.5 + 0.5 * result.precision : 1;
    const reactionBonus = result.reaction != null
      ? Math.round(100 * THREE.MathUtils.clamp(1 - (result.reaction - 0.35) / 1.65, 0, 1))
      : 0;
    const points = Math.round(result.base * distFactor * precisionFactor) + reactionBonus;

    const s = this.stats;
    s.points += points;
    s.hits++;
    if (result.zone === 'head') s.headshots++;
    if (result.type === 'duelist') {
      s.duelsWon++;
      s.reactions.push(result.reaction);
      s.bestReaction = Math.min(s.bestReaction ?? Infinity, result.reaction);
      s.avgReaction = s.reactions.reduce((a, b) => a + b, 0) / s.reactions.length;
      this.shards.burst(hit.point, 0x3a2e26, 6, shot.direction, { speed: 1.6, size: 0.6, life: 1.2 });
      this.sfx.woodHit(hit.point);
    } else if (result.type === 'gong') {
      this.sfx.steelPing(hit.point, target.radius);
    }

    const report = {
      type: result.type, zone: result.zone, label: result.label, distance,
      reaction: result.reaction, precision: result.precision, points,
    };
    s.last = report;
    this.dirty = true;

    const detail = `${distance.toFixed(1)} m` + (result.reaction != null ? ` · ${result.reaction.toFixed(2)} s` : '');
    this.text.spawn(hit.point, [`+${points}`, result.label, detail], SCORE_COLORS[result.zone] ?? '#ffe7b0');
    this.dispatchEvent({ type: 'hit', report });
    return report;
  }

  // -------------------------------------------------------------------------
  // Duels
  // -------------------------------------------------------------------------

  /** Pop up duelist `i` now (debugging and tests). */
  forcePopup(i) {
    const d = this.duelists[i];
    if (!d.popUp(this.time)) return false;
    this.duel.phase = 'live';
    this.duel.active = d;
    this.sfx.clack(d.object.position);
    return true;
  }

  #startDuel() {
    const candidates = this.duelists.filter((d) => d.state === 'down' && d !== this.duel.last);
    if (!candidates.length) {
      this.duel.timer = 0.5;
      return;
    }
    const d = candidates[Math.floor(Math.random() * candidates.length)];
    d.popUp(this.time);
    this.duel.phase = 'live';
    this.duel.active = d;
    this.sfx.bell(BELL_POSITION);
    this.sfx.clack(d.object.position);
  }

  #onDuelResolved(duelist, outcome) {
    if (outcome === 'timeout') {
      this.stats.duelsMissed++;
      this.dirty = true;
      this.text.spawn(duelist.headPosition(), ['TOO SLOW'], '#ff8a6b');
    } else if (outcome === 'knocked') {
      this.text.spawn(duelist.headPosition(), ['KNOCKED OVER', 'no score'], '#ffe7b0');
    }
    if (this.duel.active === duelist) {
      this.duel.phase = 'wait';
      this.duel.active = null;
      this.duel.last = duelist;
      this.duel.timer = DUEL_GAP[0] + Math.random() * (DUEL_GAP[1] - DUEL_GAP[0]);
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------
  update(dt) {
    this.time += dt;

    if (this.duelEnabled && this.duel.phase === 'wait') {
      this.duel.timer -= dt;
      if (this.duel.timer <= 0) this.#startDuel();
    }

    for (const t of this.targets) t.update(dt);
    this.shards.update(dt);
    this.text.update(dt, this.camera);

    if (this.dirty) {
      const r = this.stats.reactions;
      if (r.length > 64) r.splice(0, r.length - 64);
      this.scoreboard.draw(this.stats);
      this.dirty = false;
    }
  }

  /**
   * Give everything a dropped or thrown revolver can touch a physics body.
   * Moving parts (gong plates, duelist boards) follow their meshes; bottles
   * break when the gun hits them hard enough.
   */
  #registerPhysics() {
    const P = this.physics;
    for (const m of [...this.scoreboard.colliders.slice(0, 2), ...this.propMeshes]) P.addStaticFromMesh(m);
    P.addStaticFromMesh(this.resetPlate.post);
    P.addStaticFromMesh(this.resetPlate.plate, {
      onGunImpact: (speed, point) => this.sfx.steelPing(point, 0.12),
    });

    for (const d of this.duelists) {
      P.addStaticFromMesh(d.staticColliders[0]);
      P.addFollower(d.board, {
        onGunImpact: (speed) => {
          if (speed > 1.2 && d.knock()) this.sfx.woodHit(d.headPosition());
        },
      });
    }

    const q = new THREE.Quaternion();
    for (const g of this.gongs) {
      g.object.updateWorldMatrix(true, false);
      g.object.getWorldQuaternion(q);
      for (const [c, h] of g.frameParts) P.addStaticBox(g.object.localToWorld(c.clone()), h, q);
      P.addFollower(g.plate, {
        onGunImpact: (speed, point) => {
          if (speed < 0.6) return;
          g.bump(speed);
          this.sfx.steelPing(point, g.radius);
        },
      });
    }

    for (const group of this.bottleGroups) {
      group.bodies = group.bottles.map((b, i) => {
        const center = b.mesh.localToWorld(new THREE.Vector3(0, 0.15, 0));
        return P.addStaticBox(center, new THREE.Vector3(0.035, 0.15, 0.035), null, {
          surface: 'glass',
          onGunImpact: (speed) => {
            if (speed > 1.0) group.shatter(i);
          },
        });
      });
      group.onRespawn = () => group.bodies.forEach((body) => { body.collisionResponse = true; });
    }
  }

  #buildResetPlate(position) {
    const group = new THREE.Group();
    group.position.copy(position);
    group.rotation.y = Math.atan2(FIRING_LINE.x - position.x, FIRING_LINE.z - position.z);
    const post = new THREE.Mesh(worldBox(0.06, 0.9, 0.06), new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.9 }));
    post.position.y = 0.45;
    post.castShadow = true;
    post.userData.surface = 'wood';
    const plateGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.012, 24);
    plateGeo.rotateX(Math.PI / 2);
    const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color: 0xb3261e, metalness: 0.3, roughness: 0.5 }));
    plate.position.set(0, 1.0, 0.04);
    plate.castShadow = true;
    plate.userData.surface = 'steel';
    plate.name = 'resetPlate';
    group.add(post, plate);
    this.root.add(group);
    this.staticColliders.push(post);

    const target = {
      type: 'reset',
      plate,
      post,
      activeColliders: () => [plate],
      onHit: () => ({ type: 'reset' }),
      update: () => {},
    };
    plate.userData.target = target;
    return target;
  }
}
