import { describe, expect, it } from 'vitest'
import { ShotEvaluator } from '@engine/evaluate'
import { createActorMark, createEntity, createProject, parseProject, serializeProject } from '@engine/schema'
import {
  JOINT_DEFS,
  POSE_PRESETS,
  addJoints,
  clampJoint,
  compactJoints,
  createPoseKey,
  evaluatePoseKeys,
  jointFromDisplay,
  jointToDisplay,
  mirrorJoints,
  pickJointGroups,
  poseKeyAt,
  sortPoseKeys,
  upsertPoseKey
} from '@engine/pose'
import type { PoseKey } from '@engine/types'

const key = (time: number, joints: Record<string, number>, interp?: PoseKey['interp']): PoseKey => ({
  id: `k${time}`,
  time,
  joints,
  interp
})

describe('evaluatePoseKeys', () => {
  it('returns undefined with no keys and holds the only key', () => {
    expect(evaluatePoseKeys([], 1)).toBeUndefined()
    expect(evaluatePoseKeys([key(1, { elbowR: 1 })], 0)).toEqual({ elbowR: 1 })
    expect(evaluatePoseKeys([key(1, { elbowR: 1 })], 9)).toEqual({ elbowR: 1 })
  })

  it('hits every key exactly and holds before the first / after the last', () => {
    const keys = [key(0, { elbowR: 0 }), key(1, { elbowR: 1 }), key(2, { elbowR: 0.5 })]
    expect(evaluatePoseKeys(keys, -1)!.elbowR ?? 0).toBeCloseTo(0, 9)
    expect(evaluatePoseKeys(keys, 1)!.elbowR).toBeCloseTo(1, 9)
    expect(evaluatePoseKeys(keys, 2)!.elbowR).toBeCloseTo(0.5, 9)
    expect(evaluatePoseKeys(keys, 5)!.elbowR).toBeCloseTo(0.5, 9)
  })

  it('treats joints missing from a key as 0 (each key is a full pose)', () => {
    const keys = [key(0, { elbowR: 1 }, 'linear'), key(2, { kneeL: 1 })]
    const mid = evaluatePoseKeys(keys, 1)!
    expect(mid.elbowR).toBeCloseTo(0.5, 9)
    expect(mid.kneeL).toBeCloseTo(0.5, 9)
  })

  it('supports linear, ease, and step blends', () => {
    const lin = [key(0, { headY: 0 }, 'linear'), key(1, { headY: 1 })]
    const ease = [key(0, { headY: 0 }, 'ease'), key(1, { headY: 1 })]
    const step = [key(0, { headY: 0 }, 'step'), key(1, { headY: 1 })]
    expect(evaluatePoseKeys(lin, 0.25)!.headY).toBeCloseTo(0.25, 9)
    expect(evaluatePoseKeys(ease, 0.25)!.headY).toBeCloseTo(0.15625, 9)
    expect(evaluatePoseKeys(step, 0.99)!.headY).toBe(0)
    expect(evaluatePoseKeys(step, 1)!.headY).toBe(1)
  })

  it('smooth blends are continuous and pass through an interior key without a kink', () => {
    const keys = [key(0, { shoulderRX: 0 }), key(1, { shoulderRX: -1 }), key(2, { shoulderRX: -2 })]
    // Evenly spaced collinear keys → Catmull-Rom tangent at the middle key is
    // the chord slope, so the left and right derivatives match.
    const d = 1e-4
    const left = (evaluatePoseKeys(keys, 1)!.shoulderRX! - evaluatePoseKeys(keys, 1 - d)!.shoulderRX!) / d
    const right = (evaluatePoseKeys(keys, 1 + d)!.shoulderRX! - evaluatePoseKeys(keys, 1)!.shoulderRX!) / d
    expect(left).toBeCloseTo(right, 2)
    expect(left).toBeCloseTo(-1, 2)
  })

  it('is a pure function of t (same answer however it is sampled)', () => {
    const keys = sortPoseKeys([key(2, { kneeL: 1 }), key(0, { kneeL: 0 }), key(3.5, { kneeL: 0.2 })])
    const a = [0.3, 1.7, 2.9, 3.4].map((t) => evaluatePoseKeys(keys, t)!.kneeL)
    const b = [3.4, 2.9, 1.7, 0.3].map((t) => evaluatePoseKeys(keys, t)!.kneeL).reverse()
    expect(a).toEqual(b)
  })
})

describe('pose editing helpers', () => {
  it('upserts a key at the playhead instead of duplicating it', () => {
    const keys: PoseKey[] = []
    upsertPoseKey(keys, 1, { elbowR: 1 })
    upsertPoseKey(keys, 0.5, { elbowR: 0.2 })
    upsertPoseKey(keys, 1 + 1 / 1000, { elbowR: 1.4, headY: 0 })
    expect(keys.map((k) => k.time)).toEqual([0.5, 1])
    expect(keys[1]!.joints).toEqual({ elbowR: 1.4 })
    expect(poseKeyAt(keys, 0.5)?.joints.elbowR).toBe(0.2)
    expect(poseKeyAt(keys, 0.7)).toBeUndefined()
  })

  it('createPoseKey compacts zeros and omits the default interp', () => {
    const k = createPoseKey(1, { a: 0, b: 0.5 }, 'smooth')
    expect(k.joints).toEqual({ b: 0.5 })
    expect(k.interp).toBeUndefined()
    expect(createPoseKey(1, {}, 'step').interp).toBe('step')
    expect(compactJoints({ x: Number.NaN, y: 1e-9, z: 2 })).toEqual({ z: 2 })
  })

  it('mirrors left/right and flips twist', () => {
    const m = mirrorJoints({ shoulderRX: -1.5, elbowR: 0.1, hipLZ: 0.4, torsoY: 0.3, headX: 0.2 })
    expect(m).toEqual({ shoulderLX: -1.5, elbowL: 0.1, hipRZ: 0.4, torsoY: -0.3, headX: 0.2 })
    expect(mirrorJoints(mirrorJoints({ wristL: 0.3, ankleR: -0.2 }))).toEqual({ wristL: 0.3, ankleR: -0.2 })
  })

  it('picks joint groups and layers joint maps', () => {
    expect(pickJointGroups({ elbowR: 1, kneeL: 1, headY: 1 }, ['armR', 'head'])).toEqual({ elbowR: 1, headY: 1 })
    expect(addJoints(undefined, undefined)).toBeUndefined()
    expect(addJoints({ elbowR: 1 }, { elbowR: 0.5, headY: 0 }, undefined)).toEqual({ elbowR: 1.5 })
  })

  it('clamps to anatomical ranges and converts display units', () => {
    expect(clampJoint('elbowR', 10)).toBeCloseTo((150 * Math.PI) / 180, 9)
    expect(clampJoint('bodyY', -5)).toBe(-1)
    expect(clampJoint('unknownJoint', 42)).toBe(42)
    expect(jointToDisplay('headY', Math.PI / 2)).toBeCloseTo(90, 9)
    expect(jointToDisplay('bodyY', 0.3)).toBe(0.3)
    expect(jointFromDisplay('headY', 180)).toBeCloseTo(Math.PI, 9)
  })

  it('ships presets that use only known joints within range', () => {
    const known = new Set(JOINT_DEFS.map((d) => d.key))
    for (const preset of POSE_PRESETS) {
      for (const [k, v] of Object.entries(preset.joints)) {
        expect(known.has(k), `${preset.id}.${k}`).toBe(true)
        expect(clampJoint(k, v), `${preset.id}.${k}`).toBeCloseTo(v, 9)
      }
    }
  })
})

describe('ShotEvaluator pose layer', () => {
  function fixture(withMarks: boolean) {
    const doc = createProject('Pose')
    const scene = doc.scenes[0]!
    const shot = scene.shots[0]!
    const man = createEntity('person.man', 'Man', { x: 1, y: 0, z: 2 })
    scene.entities.push(man)
    const take = scene.blocking[0]!
    if (withMarks) {
      const a = createActorMark({ x: 0, y: 0, z: 0 }, 0, 'walk')
      const b = createActorMark({ x: 0, y: 0, z: -4 }, 4, 'walk')
      a.joints = { elbowR: 0.5 }
      b.joints = { elbowR: 0.5 }
      take.tracks.push({ entityId: man.id, marks: [a, b] })
    }
    take.poses = [
      { entityId: man.id, keys: [key(1, { elbowR: 0 }, 'linear'), key(3, { elbowR: 1, headY: 0.4 })] },
      { entityId: 'ent_missing', keys: [key(0, { elbowR: 9 })] }
    ]
    return { doc, scene, shot, id: man.id }
  }

  it('animates a static (unmarked) person without moving it', () => {
    const { scene, shot, id } = fixture(false)
    const ev = new ShotEvaluator(scene, shot)
    const s = ev.evaluate(2).entities.find((e) => e.entityId === id)!
    expect(s.position).toEqual({ x: 1, y: 0, z: 2 })
    expect(s.joints!.elbowR).toBeCloseTo(0.5, 9)
    expect(s.joints!.headY).toBeCloseTo(0.2, 9)
  })

  it('layers pose keys additively on mark joints', () => {
    const { scene, shot, id } = fixture(true)
    const ev = new ShotEvaluator(scene, shot)
    const s = ev.evaluate(3).entities.find((e) => e.entityId === id)!
    expect(s.joints!.elbowR).toBeCloseTo(1.5, 9)
    expect(s.position.z).toBeLessThan(-1) // still walking its marks
  })

  it('round-trips pose tracks through serialization and rejects malformed ones', () => {
    const { doc } = fixture(true)
    const json = serializeProject(doc)
    const back = parseProject(json)
    expect(back.issues).toEqual([])
    expect(serializeProject(back.doc!)).toBe(json)
    const broken = JSON.parse(json)
    broken.scenes[0].blocking[0].poses = [{ keys: 'nope' }]
    expect(parseProject(JSON.stringify(broken)).doc).toBeNull()
  })
})
