/**
 * Pose animation: point-by-point limb keyframes for people.
 *
 * A PoseTrack is a list of PoseKeys on the shot clock, independent of the
 * travel marks — keyframe a hand reaching, a kick, a head turn at any time,
 * whether the actor is walking or standing still. The evaluator interpolates
 * keys and layers the result additively on top of mark joints and the
 * entity's static pose offsets.
 *
 * Joint keys and sign conventions are shared with the renderer's person rig
 * (`animatePerson` in viewport/builders.ts) and the motion presets:
 *   shoulder?X : NEGATIVE raises the arm forward/up (−1.5 ≈ punch height).
 *   shoulder?Z : POSITIVE lifts the arm out to the side (both sides).
 *   elbow?     : POSITIVE bends the forearm toward the upper arm.
 *   wrist?     : POSITIVE bends the hand forward (palm side).
 *   hip?X      : POSITIVE swings the leg back, NEGATIVE raises it forward.
 *   hip?Z      : POSITIVE lifts the leg out to the side (both sides).
 *   knee?      : POSITIVE bends the shin backward.
 *   ankle?     : POSITIVE points the toes down.
 *   torsoX     : POSITIVE leans forward. torsoY: twist (CCW from above).
 *   torsoZ     : POSITIVE leans toward the character's right.
 *   headX      : POSITIVE nods down. headY: turn. headZ: POSITIVE tilts right.
 *   bodyY      : METERS — raise/lower the whole body (jumps, kneeling).
 *
 * Pure: no DOM, no three.js. Interpolation is a function of t only.
 */

import { newId } from './ids'
import { smoothstep } from './easing'
import type { PoseInterp, PoseKey } from './types'

export type JointGroup = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'body'

export interface JointDef {
  key: string
  label: string
  group: JointGroup
  /** Slider range — degrees for rotations, meters for bodyY. */
  min: number
  max: number
  unit: 'deg' | 'm'
}

export const JOINT_DEFS: JointDef[] = [
  { key: 'headX', label: 'Head nod', group: 'head', min: -45, max: 60, unit: 'deg' },
  { key: 'headY', label: 'Head turn', group: 'head', min: -80, max: 80, unit: 'deg' },
  { key: 'headZ', label: 'Head tilt', group: 'head', min: -40, max: 40, unit: 'deg' },
  { key: 'torsoX', label: 'Torso lean', group: 'torso', min: -45, max: 90, unit: 'deg' },
  { key: 'torsoY', label: 'Torso twist', group: 'torso', min: -80, max: 80, unit: 'deg' },
  { key: 'torsoZ', label: 'Side bend', group: 'torso', min: -45, max: 45, unit: 'deg' },
  { key: 'shoulderLX', label: 'L arm fwd', group: 'armL', min: -180, max: 90, unit: 'deg' },
  { key: 'shoulderLZ', label: 'L arm out', group: 'armL', min: -30, max: 170, unit: 'deg' },
  { key: 'elbowL', label: 'L elbow', group: 'armL', min: -10, max: 150, unit: 'deg' },
  { key: 'wristL', label: 'L wrist', group: 'armL', min: -80, max: 80, unit: 'deg' },
  { key: 'shoulderRX', label: 'R arm fwd', group: 'armR', min: -180, max: 90, unit: 'deg' },
  { key: 'shoulderRZ', label: 'R arm out', group: 'armR', min: -30, max: 170, unit: 'deg' },
  { key: 'elbowR', label: 'R elbow', group: 'armR', min: -10, max: 150, unit: 'deg' },
  { key: 'wristR', label: 'R wrist', group: 'armR', min: -80, max: 80, unit: 'deg' },
  { key: 'hipLX', label: 'L leg fwd/back', group: 'legL', min: -120, max: 60, unit: 'deg' },
  { key: 'hipLZ', label: 'L leg out', group: 'legL', min: -20, max: 90, unit: 'deg' },
  { key: 'kneeL', label: 'L knee', group: 'legL', min: -5, max: 150, unit: 'deg' },
  { key: 'ankleL', label: 'L ankle', group: 'legL', min: -40, max: 60, unit: 'deg' },
  { key: 'hipRX', label: 'R leg fwd/back', group: 'legR', min: -120, max: 60, unit: 'deg' },
  { key: 'hipRZ', label: 'R leg out', group: 'legR', min: -20, max: 90, unit: 'deg' },
  { key: 'kneeR', label: 'R knee', group: 'legR', min: -5, max: 150, unit: 'deg' },
  { key: 'ankleR', label: 'R ankle', group: 'legR', min: -40, max: 60, unit: 'deg' },
  { key: 'bodyY', label: 'Body height', group: 'body', min: -1, max: 1, unit: 'm' }
]

export const JOINT_GROUP_LABELS: Record<JointGroup, string> = {
  head: 'Head',
  torso: 'Torso',
  armL: 'Left arm',
  armR: 'Right arm',
  legL: 'Left leg',
  legR: 'Right leg',
  body: 'Whole body'
}

const DEF_BY_KEY = new Map(JOINT_DEFS.map((d) => [d.key, d]))

export function jointDef(key: string): JointDef | undefined {
  return DEF_BY_KEY.get(key)
}

/** Joint value in its native unit (radians or meters) → slider unit. */
export function jointToDisplay(key: string, value: number): number {
  return DEF_BY_KEY.get(key)?.unit === 'm' ? value : (value * 180) / Math.PI
}

/** Slider unit → native joint value. */
export function jointFromDisplay(key: string, display: number): number {
  return DEF_BY_KEY.get(key)?.unit === 'm' ? display : (display * Math.PI) / 180
}

/** Clamp a native joint value to its anatomical range. */
export function clampJoint(key: string, value: number): number {
  const def = DEF_BY_KEY.get(key)
  if (!def) return value
  const lo = jointFromDisplay(key, def.min)
  const hi = jointFromDisplay(key, def.max)
  return Math.min(hi, Math.max(lo, value))
}

/* ------------------------------ interpolation ----------------------------- */

/** Keys sorted by time (stable for equal times). */
export function sortPoseKeys(keys: readonly PoseKey[]): PoseKey[] {
  return [...keys].sort((a, b) => a.time - b.time)
}

function unionKeys(...poses: (Record<string, number> | undefined)[]): string[] {
  const set = new Set<string>()
  for (const p of poses) if (p) for (const k of Object.keys(p)) set.add(k)
  return [...set].sort()
}

/** Drop exact zeros so documents stay small and diffs stay readable. */
export function compactJoints(j: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(j).sort()) {
    const v = j[key]!
    if (Number.isFinite(v) && Math.abs(v) > 1e-6) out[key] = v
  }
  return out
}

/**
 * Evaluate a pose track at time t. `sorted` must be time-ordered
 * (sortPoseKeys). Each key is a FULL pose: joints it doesn't list read as 0.
 * The key's `interp` shapes the segment LEAVING it:
 *   smooth — Catmull-Rom through neighbouring keys (fluid, default)
 *   ease   — ease-in/out, settling on every key
 *   linear — constant speed
 *   step   — hold until the next key
 */
export function evaluatePoseKeys(
  sorted: readonly PoseKey[],
  t: number
): Record<string, number> | undefined {
  if (sorted.length === 0) return undefined
  const first = sorted[0]!
  if (sorted.length === 1 || t <= first.time) return { ...first.joints }
  const last = sorted[sorted.length - 1]!
  if (t >= last.time) return { ...last.joints }

  let i = 0
  while (i < sorted.length - 2 && t >= sorted[i + 1]!.time) i++
  const k0 = sorted[i]!
  const k1 = sorted[i + 1]!
  const span = k1.time - k0.time
  if (span <= 1e-9) return { ...k1.joints }
  const u = (t - k0.time) / span
  const interp: PoseInterp = k0.interp ?? 'smooth'

  if (interp === 'step') return { ...k0.joints }
  if (interp === 'linear' || interp === 'ease') {
    const w = interp === 'ease' ? smoothstep(u) : u
    const out: Record<string, number> = {}
    for (const key of unionKeys(k0.joints, k1.joints)) {
      const a = k0.joints[key] ?? 0
      const b = k1.joints[key] ?? 0
      out[key] = a + (b - a) * w
    }
    return out
  }

  // Non-uniform Catmull-Rom (cubic Hermite with finite-difference tangents).
  // End keys get zero tangents so a move starts and lands softly.
  const kPrev = i > 0 ? sorted[i - 1]! : null
  const kNext = i + 2 < sorted.length ? sorted[i + 2]! : null
  const u2 = u * u
  const u3 = u2 * u
  const h00 = 2 * u3 - 3 * u2 + 1
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  const out: Record<string, number> = {}
  for (const key of unionKeys(kPrev?.joints, k0.joints, k1.joints, kNext?.joints)) {
    const p0 = k0.joints[key] ?? 0
    const p1 = k1.joints[key] ?? 0
    // A step key before this one means the previous segment jumped — don't
    // let that jump leak into this segment's tangent.
    const m0 =
      kPrev && (kPrev.interp ?? 'smooth') !== 'step'
        ? (p1 - (kPrev.joints[key] ?? 0)) / (k1.time - kPrev.time)
        : 0
    const m1 = kNext ? ((kNext.joints[key] ?? 0) - p0) / (kNext.time - k0.time) : 0
    out[key] = h00 * p0 + h10 * span * m0 + h01 * p1 + h11 * span * m1
  }
  return out
}

/* --------------------------------- editing -------------------------------- */

/** Keys within this many seconds of the playhead are "the key at t". */
export const POSE_KEY_EPSILON = 1 / 120

export function poseKeyAt(keys: readonly PoseKey[], t: number, eps = POSE_KEY_EPSILON): PoseKey | undefined {
  let best: PoseKey | undefined
  let bestD = Infinity
  for (const k of keys) {
    const d = Math.abs(k.time - t)
    if (d <= eps && d < bestD) {
      best = k
      bestD = d
    }
  }
  return best
}

export function createPoseKey(time: number, joints: Record<string, number>, interp?: PoseInterp): PoseKey {
  const key: PoseKey = { id: newId('pose'), time, joints: compactJoints(joints) }
  if (interp && interp !== 'smooth') key.interp = interp
  return key
}

/**
 * Write a pose at time t: updates the key already at t, or inserts a new
 * one. Mutates and returns `keys` (call inside store.mutate).
 */
export function upsertPoseKey(keys: PoseKey[], t: number, joints: Record<string, number>): PoseKey {
  const existing = poseKeyAt(keys, t)
  if (existing) {
    existing.joints = compactJoints(joints)
    return existing
  }
  const key = createPoseKey(t, joints)
  keys.push(key)
  keys.sort((a, b) => a.time - b.time)
  return key
}

/* --------------------------------- helpers -------------------------------- */

const MIRROR_NEGATE = new Set(['torsoY', 'torsoZ', 'headY', 'headZ'])

/** Swap left/right sides (and flip twist/tilt) — mirror a punch to the other hand. */
export function mirrorJoints(j: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, v] of Object.entries(j)) {
    let target = key
    const m = /^(shoulder|elbow|wrist|hip|knee|ankle)([LR])(X|Z)?$/.exec(key)
    if (m) target = `${m[1]}${m[2] === 'L' ? 'R' : 'L'}${m[3] ?? ''}`
    out[target] = MIRROR_NEGATE.has(key) ? -v : v
  }
  return compactJoints(out)
}

/** Keep only the joints of the given groups (copy just an arm). */
export function pickJointGroups(j: Record<string, number>, groups: JointGroup[]): Record<string, number> {
  const allowed = new Set(groups)
  const out: Record<string, number> = {}
  for (const [key, v] of Object.entries(j)) {
    const def = DEF_BY_KEY.get(key)
    if (def && allowed.has(def.group)) out[key] = v
  }
  return out
}

/** Sum joint maps (layering: static offsets + mark joints + pose keys). */
export function addJoints(
  ...layers: (Record<string, number> | undefined)[]
): Record<string, number> | undefined {
  let out: Record<string, number> | undefined
  for (const layer of layers) {
    if (!layer) continue
    for (const [key, v] of Object.entries(layer)) {
      if (v === 0) continue
      out ??= {}
      out[key] = (out[key] ?? 0) + v
    }
  }
  return out
}

/* --------------------------------- presets -------------------------------- */

export interface PosePreset {
  id: string
  name: string
  joints: Record<string, number>
}

/** One-click starting poses — apply, then refine by dragging limbs. */
export const POSE_PRESETS: PosePreset[] = [
  { id: 'neutral', name: 'Neutral', joints: {} },
  { id: 'tpose', name: 'T-pose', joints: { shoulderLZ: 1.57, shoulderRZ: 1.57 } },
  {
    id: 'handsUp',
    name: 'Hands up',
    joints: { shoulderLX: -2.9, shoulderRX: -2.9, shoulderLZ: 0.3, shoulderRZ: 0.3, elbowL: 0.35, elbowR: 0.35 }
  },
  {
    id: 'point',
    name: 'Point',
    joints: { shoulderRX: -1.45, shoulderRZ: 0.1, elbowR: 0.05, headY: -0.15, torsoY: -0.15 }
  },
  {
    id: 'wave',
    name: 'Wave',
    joints: { shoulderRZ: 1.35, shoulderRX: -0.35, elbowR: 1.7, wristR: -0.3, headZ: -0.08 }
  },
  {
    id: 'guard',
    name: 'Guard stance',
    joints: { shoulderLX: -0.9, shoulderRX: -0.9, elbowL: 1.8, elbowR: 1.8, torsoX: 0.15, kneeL: 0.25, kneeR: 0.25, bodyY: -0.05 }
  },
  {
    id: 'punch',
    name: 'Punch',
    joints: { shoulderLX: -0.9, elbowL: 1.8, shoulderRX: -1.55, elbowR: 0.1, torsoY: 0.35, torsoX: 0.15 }
  },
  {
    id: 'kick',
    name: 'Front kick',
    joints: { hipRX: -1.5, kneeR: 0.2, ankleR: 0.4, shoulderLX: -0.6, shoulderRX: -0.6, elbowL: 1.5, elbowR: 1.5, torsoX: -0.2 }
  },
  {
    id: 'handsHips',
    name: 'Hands on hips',
    joints: { shoulderLZ: 0.55, shoulderRZ: 0.55, shoulderLX: 0.25, shoulderRX: 0.25, elbowL: 1.6, elbowR: 1.6 }
  },
  {
    id: 'armsCrossed',
    name: 'Arms crossed',
    joints: { shoulderLX: -0.55, shoulderRX: -0.55, shoulderLZ: -0.25, shoulderRZ: -0.25, elbowL: 2.0, elbowR: 2.0 }
  },
  {
    id: 'kneel',
    name: 'Kneel',
    joints: { hipLX: -1.45, kneeL: 1.5, hipRX: 0.1, kneeR: 1.6, ankleR: 0.9, bodyY: -0.45 }
  },
  {
    id: 'lookUp',
    name: 'Look up',
    joints: { headX: -0.55, torsoX: -0.15 }
  }
]
