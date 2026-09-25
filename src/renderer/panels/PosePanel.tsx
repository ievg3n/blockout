/**
 * Pose & limb animation UI for people: the pose-tool toggle, pose keys on
 * the shot clock (Shoot) or the static stance (Stage), one-click starting
 * poses, mirror/copy/paste, and grouped joint sliders.
 *
 * What gets edited mirrors SceneManager's drag target: in SHOOT a pose key at
 * the playhead (created on first edit, seeded from the interpolated pose so
 * nothing pops); in STAGE the entity's untimed limb offsets.
 */

import { useStore } from '../store'
import {
  JOINT_DEFS,
  JOINT_GROUP_LABELS,
  POSE_PRESETS,
  evaluatePoseKeys,
  jointFromDisplay,
  jointToDisplay,
  mirrorJoints,
  poseKeyAt,
  sortPoseKeys,
  type JointGroup
} from '@engine/pose'
import type { Entity, PoseInterp } from '@engine/types'
import { poseHandle } from '../viewport/pose-ik'

const GROUP_ORDER: JointGroup[] = ['armR', 'armL', 'legR', 'legL', 'torso', 'head', 'body']

/** Grouped sliders over a joint map; `onChange` gets native units. */
export function JointSliders({
  values,
  onChange,
  openGroup,
  idPrefix
}: {
  values: Record<string, number>
  onChange: (key: string, value: number) => void
  openGroup?: JointGroup | null
  idPrefix: string
}): JSX.Element {
  return (
    <div className="joint-sliders">
      {GROUP_ORDER.map((group) => {
        const defs = JOINT_DEFS.filter((d) => d.group === group)
        const touched = defs.some((d) => (values[d.key] ?? 0) !== 0)
        return (
          <details key={`${idPrefix}-${group}`} open={openGroup === group || undefined} className="joint-group">
            <summary>
              {JOINT_GROUP_LABELS[group]}
              {touched && <span className="joint-dot" title="Posed" />}
            </summary>
            {defs.map((d) => {
              const display = jointToDisplay(d.key, values[d.key] ?? 0)
              const shown = d.unit === 'm' ? display.toFixed(2) + ' m' : `${Math.round(display)}°`
              return (
                <div className="field joint-field" key={d.key}>
                  <label htmlFor={`${idPrefix}-${d.key}`}>
                    {d.label} <span className="joint-value">{shown}</span>
                  </label>
                  <input
                    id={`${idPrefix}-${d.key}`}
                    type="range"
                    min={d.min}
                    max={d.max}
                    step={d.unit === 'm' ? 0.01 : 1}
                    value={d.unit === 'm' ? display : Math.round(display)}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isNaN(v)) onChange(d.key, jointFromDisplay(d.key, v))
                    }}
                    onDoubleClick={() => onChange(d.key, 0)}
                    title="Double-click to reset"
                  />
                </div>
              )
            })}
          </details>
        )
      })}
    </div>
  )
}

const INTERPS: { id: PoseInterp; label: string; hint: string }[] = [
  { id: 'smooth', label: 'Smooth', hint: 'Fluid curve through the neighbouring keys' },
  { id: 'ease', label: 'Ease', hint: 'Ease out of this key and settle into the next' },
  { id: 'linear', label: 'Linear', hint: 'Constant speed to the next key' },
  { id: 'step', label: 'Hold', hint: 'Hold this pose, then snap to the next key' }
]

export function PoseToolSection({ entity }: { entity: Entity }): JSX.Element {
  const mode = useStore((s) => s.mode)
  const time = useStore((s) => s.time)
  const poseMode = useStore((s) => s.poseMode)
  const poseJoint = useStore((s) => s.poseJoint)
  const clipboard = useStore((s) => s.poseClipboard)
  const track = useStore((s) => s.poseTrack(entity.id))
  const shot = useStore((s) => s.shot())
  const s = useStore.getState()

  const keyed = mode === 'shoot'
  const keys = track ? sortPoseKeys(track.keys) : []
  const keyHere = poseKeyAt(keys, time)
  const statics: Record<string, number> = {}
  for (const [k, v] of Object.entries(entity.params ?? {})) {
    if (k.startsWith('joint_') && typeof v === 'number') statics[k.slice(6)] = v
  }
  const values = keyed ? (evaluatePoseKeys(keys, time) ?? {}) : statics
  const write = (joints: Record<string, number>): void => {
    if (keyed) s.setPoseKey(entity.id, time, joints)
    else s.setStaticPose(entity.id, joints)
  }
  const openGroup = poseHandle(poseJoint)?.group ?? null
  const prevKey = [...keys].reverse().find((k) => k.time < time - 1e-3)
  const nextKey = keys.find((k) => k.time > time + 1e-3)
  const duration = shot?.duration ?? 1

  return (
    <div className="panel-section pose-section">
      <div className="panel-title">🦴 Pose &amp; limb animation</div>
      <button
        className={`btn ${poseMode ? 'primary' : ''}`}
        style={{ width: '100%', marginBottom: 8 }}
        onClick={() => s.setPoseMode(!poseMode)}
        title="Show joint handles on this person — drag a hand, foot, elbow, knee, the head, chest, or hips (P)"
      >
        {poseMode ? '✓ Pose tool on — drag the joints' : 'Pose limbs in the viewport (P)'}
      </button>
      <p className="pose-hint">
        {keyed ? (
          <>
            Each drag or slider change <b>keys the pose at {time.toFixed(2)}s</b>. Move the playhead,
            pose again — the limbs animate between keys. <kbd>K</kbd> keys the current pose.
          </>
        ) : (
          <>
            Stage sets the <b>standing pose</b> (no timeline). Switch to <b>Shoot</b> to animate limbs
            key by key.
          </>
        )}
      </p>

      {keyed && (
        <>
          <div className="pose-key-strip" aria-label="Pose keys">
            <div className="pose-key-rail">
              {keys.map((k) => (
                <button
                  key={k.id}
                  className={`pose-key-diamond${k === keyHere ? ' active' : ''}`}
                  style={{ left: `${Math.min(100, (k.time / duration) * 100)}%` }}
                  title={`Key at ${k.time.toFixed(2)}s — click to jump`}
                  onClick={() => s.setTime(k.time)}
                />
              ))}
              <div className="pose-key-playhead" style={{ left: `${Math.min(100, (time / duration) * 100)}%` }} />
            </div>
          </div>
          <div className="field-row" style={{ marginBottom: 8 }}>
            <button className="btn small" disabled={!prevKey} onClick={() => prevKey && s.setTime(prevKey.time)} title="Previous pose key">
              ◀
            </button>
            <button
              className="btn small"
              style={{ flex: 1 }}
              onClick={() => write(values)}
              title="Key the current pose at the playhead (K)"
            >
              ◆ {keyHere ? 'Re-key' : 'Key'} at {time.toFixed(2)}s
            </button>
            <button className="btn small" disabled={!nextKey} onClick={() => nextKey && s.setTime(nextKey.time)} title="Next pose key">
              ▶
            </button>
            <button
              className="btn small"
              disabled={!keyHere}
              onClick={() => keyHere && s.deletePoseKey(entity.id, keyHere.id)}
              title="Delete the key at the playhead"
            >
              🗑
            </button>
          </div>
          {keyHere && (
            <div className="field">
              <label>Blend to next key</label>
              <div className="seg">
                {INTERPS.map((i) => (
                  <button
                    key={i.id}
                    className={(keyHere.interp ?? 'smooth') === i.id ? 'active' : ''}
                    title={i.hint}
                    onClick={() => s.setPoseKeyInterp(entity.id, keyHere.id, i.id)}
                  >
                    {i.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="field">
        <label>Quick poses</label>
        <div className="pose-presets">
          {POSE_PRESETS.map((p) => (
            <button key={p.id} className="btn small" onClick={() => write(p.joints)}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="pose-tools">
        <button className="btn small" onClick={() => write(mirrorJoints(values))} title="Swap left and right sides">
          ⇆ Mirror
        </button>
        <button className="btn small" onClick={() => s.setPoseClipboard({ ...values })} title="Copy this pose">
          Copy
        </button>
        <button
          className="btn small"
          disabled={!clipboard}
          onClick={() => clipboard && write(clipboard)}
          title="Paste the copied pose here (works across actors)"
        >
          Paste
        </button>
        <button className="btn small" onClick={() => write({})} title="Return every joint to neutral">
          Reset
        </button>
      </div>

      <JointSliders
        idPrefix={`pose-${entity.id}`}
        values={values}
        openGroup={openGroup}
        onChange={(key, v) => write({ ...values, [key]: v })}
      />

      {keyed && keys.length > 0 && (
        <button
          className="btn small"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => s.clearPoseKeys(entity.id)}
        >
          Clear all {keys.length} pose key{keys.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
