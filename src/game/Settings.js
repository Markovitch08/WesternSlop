import * as THREE from 'three';

const KEY = 'westernslop.settings.v1';

/** Every setting: its choices (values) and display labels. */
export const SETTINGS = {
  handedness: { label: 'Handedness', values: ['right', 'left'], names: ['Right', 'Left'] },
  secondGun: { label: 'Second gun', values: [false, true], names: ['Off', 'On'] },
  turning: { label: 'Turning', values: ['off', 'snap', 'smooth'], names: ['Off', 'Snap 30°', 'Smooth'] },
  sfxVolume: { label: 'Effects volume', values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], percent: true },
  ambienceVolume: { label: 'Ambience volume', values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], percent: true },
  quality: { label: 'Quality', values: ['high', 'medium', 'low'], names: ['High', 'Medium', 'Low'] },
  perfMeter: { label: 'Performance meter', values: [false, true], names: ['Off', 'On'] },
};

export const DEFAULTS = {
  handedness: 'right',
  secondGun: false,
  turning: 'snap',
  sfxVolume: 1,
  ambienceVolume: 0.7,
  quality: 'high',
  perfMeter: false,
};

/**
 * Player settings, saved in localStorage (when the browser allows it).
 * Dispatches { type: 'change', key, value } for every change.
 */
export class Settings extends THREE.EventDispatcher {
  constructor() {
    super();
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
          if (k in saved && SETTINGS[k].values.includes(saved[k])) this.values[k] = saved[k];
        }
      }
    } catch { /* storage blocked: use defaults */ }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (!SETTINGS[key]?.values.includes(value) || this.values[key] === value) return;
    this.values[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch { /* storage blocked: keep it for this session */ }
    this.dispatchEvent({ type: 'change', key, value });
  }

  /** Step a setting to its next (+1) or previous (-1) choice (clamped for volumes, wrapping otherwise). */
  step(key, dir) {
    const def = SETTINGS[key];
    const i = def.values.indexOf(this.values[key]);
    let j = i + dir;
    if (def.percent) j = Math.min(def.values.length - 1, Math.max(0, j));
    else j = (j + def.values.length) % def.values.length;
    this.set(key, def.values[j]);
  }

  /** Display text for a setting's current value. */
  display(key) {
    const def = SETTINGS[key];
    const v = this.values[key];
    if (def.percent) return `${Math.round(v * 100)}%`;
    return def.names[def.values.indexOf(v)];
  }

  /** Apply every current value (on startup) by dispatching a change for each. */
  applyAll() {
    for (const [key, value] of Object.entries(this.values)) this.dispatchEvent({ type: 'change', key, value });
  }
}
