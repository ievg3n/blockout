/**
 * Pose tool support: the grabbable handles on a person rig and a small
 * damped-least-squares IK solver that turns "drag the hand here" into joint
 * values (shoulder + elbow), "drag the foot here" into hip + knee, and so on.
 *
 * The solver drives the REAL rig through BuiltAsset.animate() with trial
 * overrides, so it needs no knowledge of axis/sign conventions — whatever the
 * renderer draws is what the solver optimizes. Output is plain joint values
 * (engine/pose.ts keys), clamped to anatomical ranges. Interactive only: it
 * never runs on the export path, so determinism is unaffected.
 */

import * as THREE from 'three'
import { clampJoint, type JointGroup } from '@engine/pose'
import type { AnimInput, PersonRig } from './builders'

export type PoseHandleId =
  | 'handL'
  | 'handR'
  | 'elbowL'
  | 'elbowR'
  | 'footL'
  | 'footR'
  | 'kneeL'
  | 'kneeR'
  | 'head'
  | 'chest'
  | 'pelvis'

export interface PoseHandleDef {
  id: PoseHandleId
  label: string
  group: JointGroup
  /** Joint keys the drag solves for (first = most influential). */
  dofs: string[]
  /** Where the handle sits on the rig. */
  node: (rig: PersonRig) => THREE.Object3D
  side: 'L' | 'R' | 'C'
}

export const POSE_HANDLES: PoseHandleDef[] = [
  { id: 'handL', label: 'Left hand', group: 'armL', dofs: ['shoulderLX', 'shoulderLZ', 'elbowL'], node: (r) => r.anchors.handL, side: 'L' },
  { id: 'handR', label: 'Right hand', group: 'armR', dofs: ['shoulderRX', 'shoulderRZ', 'elbowR'], node: (r) => r.anchors.handR, side: 'R' },
  { id: 'elbowL', label: 'Left elbow', group: 'armL', dofs: ['shoulderLX', 'shoulderLZ'], node: (r) => r.joints.elbowL, side: 'L' },
  { id: 'elbowR', label: 'Right elbow', group: 'armR', dofs: ['shoulderRX', 'shoulderRZ'], node: (r) => r.joints.elbowR, side: 'R' },
  { id: 'footL', label: 'Left foot', group: 'legL', dofs: ['hipLX', 'hipLZ', 'kneeL'], node: (r) => r.anchors.footL, side: 'L' },
  { id: 'footR', label: 'Right foot', group: 'legR', dofs: ['hipRX', 'hipRZ', 'kneeR'], node: (r) => r.anchors.footR, side: 'R' },
  { id: 'kneeL', label: 'Left knee', group: 'legL', dofs: ['hipLX', 'hipLZ'], node: (r) => r.joints.kneeL, side: 'L' },
  { id: 'kneeR', label: 'Right knee', group: 'legR', dofs: ['hipRX', 'hipRZ'], node: (r) => r.joints.kneeR, side: 'R' },
  { id: 'head', label: 'Head', group: 'head', dofs: ['headX', 'headZ'], node: (r) => r.anchors.head, side: 'C' },
  { id: 'chest', label: 'Chest', group: 'torso', dofs: ['torsoX', 'torsoZ'], node: (r) => r.anchors.chest, side: 'C' },
  { id: 'pelvis', label: 'Hips (body height)', group: 'body', dofs: ['bodyY'], node: (r) => r.joints.pelvis, side: 'C' }
]

export function poseHandle(id: string | null): PoseHandleDef | undefined {
  return POSE_HANDLES.find((h) => h.id === id)
}

/** Skeleton lines drawn between handles/joints (pairs of node getters). */
export const POSE_BONES: ((r: PersonRig) => [THREE.Object3D, THREE.Object3D])[] = [
  (r) => [r.joints.pelvis, r.anchors.chest],
  (r) => [r.anchors.chest, r.anchors.head],
  (r) => [r.joints.shoulderL, r.joints.elbowL],
  (r) => [r.joints.elbowL, r.anchors.handL],
  (r) => [r.joints.shoulderR, r.joints.elbowR],
  (r) => [r.joints.elbowR, r.anchors.handR],
  (r) => [r.joints.hipL, r.joints.kneeL],
  (r) => [r.joints.kneeL, r.anchors.footL],
  (r) => [r.joints.hipR, r.joints.kneeR],
  (r) => [r.joints.kneeR, r.anchors.footR],
  (r) => [r.joints.shoulderL, r.joints.shoulderR],
  (r) => [r.joints.hipL, r.joints.hipR]
]

export interface IkProblem {
  rig: PersonRig
  /** Re-poses the rig (BuiltAsset.animate). */
  animate: (input: AnimInput) => void
  /** Animation input for the current frame, minus overrides. */
  input: AnimInput
  /** Offsets from every OTHER layer (static params, mark joints). */
  base: Record<string, number>
  /** The layer being edited (pose key at t, or static pose) — start values. */
  layer: Record<string, number>
  handle: PoseHandleDef
  /** World-space goal for the handle. */
  target: THREE.Vector3
}

const tmp = new THREE.Vector3()

/** IK never hyper-extends hinges (sliders may, for stylized poses). */
const IK_MIN: Record<string, number> = { elbowL: 0, elbowR: 0, kneeL: 0, kneeR: 0 }

function clampIk(key: string, v: number): number {
  const min = IK_MIN[key]
  return clampJoint(key, min !== undefined ? Math.max(min, v) : v)
}

/** Solve; returns the edited layer (a new object). Leaves the rig posed at the solution. */
export function solvePoseIk(p: IkProblem): Record<string, number> {
  const layer = { ...p.layer }
  const dofs = p.handle.dofs
  const node = p.handle.node(p.rig)
  const root = p.rig.joints.root

  const fk = (): THREE.Vector3 => {
    const overrides = { ...p.base }
    for (const [k, v] of Object.entries(layer)) overrides[k] = (overrides[k] ?? 0) + v
    p.animate({ ...p.input, overrides })
    // The rig root's parents (entity root) are already current this frame.
    root.updateWorldMatrix(true, true)
    return node.getWorldPosition(new THREE.Vector3())
  }

  // Body height is a straight vertical offset — no iteration needed.
  if (dofs.length === 1 && dofs[0] === 'bodyY') {
    const pos = fk()
    layer.bodyY = clampJoint('bodyY', (layer.bodyY ?? 0) + (p.target.y - pos.y))
    fk()
    return layer
  }

  const n = dofs.length
  const h = 1e-3
  let lambda = 0.08
  let pos = fk()
  let err = tmp.copy(p.target).sub(pos).length()
  for (let iter = 0; iter < 24 && err > 5e-4; iter++) {
    // Numeric Jacobian: 3 × n.
    const J: THREE.Vector3[] = []
    for (const key of dofs) {
      const v0 = layer[key] ?? 0
      layer[key] = v0 + h
      const ph = fk()
      layer[key] = v0
      J.push(ph.sub(pos).divideScalar(h))
    }
    const e = new THREE.Vector3().copy(p.target).sub(pos)
    // Damped least squares: Δθ = Jᵀ (J Jᵀ + λ² I)⁻¹ e.
    const A = new THREE.Matrix3()
    const el = A.elements // column-major
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let sum = r === c ? lambda * lambda : 0
        for (let k = 0; k < n; k++) sum += J[k]!.getComponent(r) * J[k]!.getComponent(c)
        el[c * 3 + r] = sum
      }
    }
    if (Math.abs(A.determinant()) < 1e-12) break
    const y = e.clone().applyMatrix3(A.invert())
    const before = { ...layer }
    for (let k = 0; k < n; k++) {
      const key = dofs[k]!
      // Cap each step so the limb can't flip through the body in one frame.
      const step = Math.max(-0.35, Math.min(0.35, J[k]!.dot(y)))
      layer[key] = clampIk(key, (layer[key] ?? 0) + step)
    }
    const nextPos = fk()
    const nextErr = tmp.copy(p.target).sub(nextPos).length()
    if (nextErr < err) {
      pos = nextPos
      err = nextErr
      lambda = Math.max(0.01, lambda * 0.7)
    } else {
      // Overshot — undo and damp harder.
      Object.assign(layer, before)
      for (const key of dofs) if (!(key in before)) delete layer[key]
      lambda *= 2.5
      pos = fk()
      if (lambda > 4) break
    }
  }
  fk()
  return layer
}
