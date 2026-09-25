// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
/**
 * App shell: welcome screen, titlebar with the three-mode switch, the
 * Stage/Shoot/Deliver layouts, global keyboard map, and autosave.
 */

import { useCallback, useEffect } from 'react'
import { useStore, currentProjectJson } from './store'
import { evaluatePoseKeys, sortPoseKeys } from '@engine/pose'
import { Viewport } from './viewport/Viewport'
import { Library } from './panels/Library'
import { Inspector } from './panels/Inspector'
import { ProjectRail } from './panels/ProjectRail'
import { Timeline } from './panels/Timeline'
import { DeliverPanel } from './panels/DeliverPanel'
import { Toasts } from './panels/Toasts'
import { HelpOverlay, BlockingCoach } from './panels/Help'
import { PanelResizer } from './panels/PanelResizer'
import logoUrl from './assets/logo.png'
import { DISTRIBUTION } from '../shared/distribution'

const PLATFORM_CLASS = `platform-${window.blockout.platform.platform}`

function CreditLink({ url, children }: { url: string; children: string }): JSX.Element {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault()
        void window.blockout.openExternal(url)
      }}
      style={{ color: 'var(--accent)', textDecoration: 'none', cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
    >
      {children}
    </a>
  )
}

export function Credits({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <div
      style={{
        color: 'var(--text-faint)',
        fontSize: compact ? 10 : 12,
        textAlign: 'center',
        lineHeight: 1.6,
        padding: compact ? '10px 12px' : 0
      }}
    >
      Created by Sam Wasserman
      {compact ? <br /> : ' · '}
      <CreditLink url="https://wassermanproductions.com">wassermanproductions.com</CreditLink>
      {' · '}
      <CreditLink url="https://wasserman.ai">wasserman.ai</CreditLink>
      {!compact && (
        <>
          <br />
          Open source under Apache-2.0 — keep this credit when using or forking.
          {DISTRIBUTION.maintainerCredit && (
            <>
              <br />
              {DISTRIBUTION.maintainerCredit}
            </>
          )}
        </>
      )}
    </div>
  )
}

function Welcome(): JSX.Element {
  const newProject = useStore((s) => s.newProject)
  const loadFromJson = useStore((s) => s.loadFromJson)
  const toast = useStore((s) => s.toast)

  const onNew = useCallback(async () => {
    const project = await window.blockout.newProjectDialog()
    if (!project) return
    const { folder, name } = project
    newProject(folder, name)
    const json = currentProjectJson()
    if (json) await window.blockout.saveProject(folder, json)
  }, [newProject])

  const onOpen = useCallback(async () => {
    const folder = await window.blockout.openProjectDialog()
    if (!folder) return
    const { json, backupJson, backupNewer } = await window.blockout.loadProject(folder)
    if (!json && !backupJson) {
      toast('No project.json found in that folder.', 'error')
      return
    }
    // A meaningfully-newer autosave means the app died with unsaved work —
    // restore it (undo history is fresh either way; ⌘S makes it permanent).
    if (backupNewer && backupJson && loadFromJson(folder, backupJson)) {
      toast('Restored unsaved work from the autosave backup — Save to keep it.', 'success')
      return
    }
    if (json && loadFromJson(folder, json)) return
    if (backupJson && loadFromJson(folder, backupJson)) {
      toast('Recovered from autosave backup.', 'success')
    }
  }, [loadFromJson, toast])

  return (
    <div className="welcome">
      <img
        src={logoUrl}
        alt="Blockout"
        style={{ width: 260, height: 260, objectFit: 'contain', borderRadius: 16, marginBottom: -8 }}
      />
      <p>
        Stage a scene, choreograph camera and character blocking with marks, and export
        motion-reference packages for AI video generators.
      </p>
      <div className="actions">
        <button className="btn primary" onClick={onNew}>
          New Project
        </button>
        <button className="btn" onClick={onOpen}>
          Open Project…
        </button>
        <button className="btn" onClick={() => useStore.getState().setHelpOpen(true)}>
          ? Tutorial
        </button>
      </div>
      <Credits />
    </div>
  )
}

function useAutosave(): void {
  // Depend on WHETHER a doc is open, not on the doc object — every mutation
  // replaces the doc, and re-arming a 60s timer on each edit means autosave
  // never fires for anyone actively working (the exact crash window it
  // exists to cover). The tick reads the latest doc from the store.
  const hasDoc = useStore((s) => s.doc !== null)
  const folder = useStore((s) => s.projectFolder)

  useEffect(() => {
    if (!hasDoc || !folder) return
    const interval = setInterval(() => {
      const json = currentProjectJson()
      if (json) void window.blockout.saveBackup(folder, json)
    }, 60_000)
    return () => clearInterval(interval)
  }, [hasDoc, folder])
}

function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (!s.doc) return
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLSelectElement
      if (inField) return

      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        s.undo()
      } else if (meta && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        s.redo()
      } else if (meta && e.key === 's') {
        e.preventDefault()
        const json = currentProjectJson()
        if (json && s.projectFolder) {
          void window.blockout.saveProject(s.projectFolder, json).then(() => s.markSaved())
        }
      } else if (e.key === ' ') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if (e.key === 'm' || e.key === 'M') {
        if (s.mode === 'shoot' && s.selection) s.setDroppingMarks(!s.droppingMarks)
      } else if (e.key === 'c' || e.key === 'C') {
        // Toggle everywhere except Deliver (which is always the shot view) —
        // being stuck in look-through with no exit was a real trap.
        if (s.mode !== 'deliver') s.setLookThrough(!s.lookThrough)
      } else if ((e.key === 'p' || e.key === 'P') && !meta) {
        // Pose tool: grab hands, feet, elbows, knees, head, chest in the viewport.
        if (s.mode === 'deliver') return
        if (s.poseMode) {
          s.setPoseMode(false)
          return
        }
        const sel = s.selection
        const entity = sel?.kind === 'entity' ? s.scene()?.entities.find((x) => x.id === sel.entityId) : undefined
        if (entity?.assetId.startsWith('person.')) s.setPoseMode(true)
        else s.toast('Select a person first, then press P to pose their limbs.', 'info')
      } else if ((e.key === 'k' || e.key === 'K') && !meta) {
        // Key the current pose at the playhead (Shoot) — a hold/anchor key.
        const sel = s.selection
        if (s.mode !== 'shoot' || sel?.kind !== 'entity') return
        const entity = s.scene()?.entities.find((x) => x.id === sel.entityId)
        if (!entity?.assetId.startsWith('person.')) return
        const track = s.poseTrack(entity.id)
        const current = track ? (evaluatePoseKeys(sortPoseKeys(track.keys), s.time) ?? {}) : {}
        s.setPoseKey(entity.id, s.time, current)
        s.toast(`Pose keyed at ${s.time.toFixed(2)}s.`, 'success')
      } else if (e.key === '?') {
        s.setHelpOpen(!s.helpOpen)
      } else if (e.key === 'Escape') {
        if (s.helpOpen) {
          s.setHelpOpen(false)
          return
        }
        if (s.poseMode) {
          s.setPoseMode(false)
          return
        }
        s.setPlacingAsset(null)
        s.setPlacingSequence(null)
        s.setPlacingChoreography(null)
        s.setDroppingMarks(false)
        s.setSelection(null)
      } else if (e.key >= '1' && e.key <= '9') {
        // Jump to camera mark N.
        const shot = s.shot()
        const idx = Number(e.key) - 1
        const mark = shot ? [...shot.camera.marks].sort((a, b) => a.time - b.time)[idx] : undefined
        if (mark) s.setTime(mark.time)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function App(): JSX.Element {
  const doc = useStore((s) => s.doc)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const dirty = useStore((s) => s.dirty)
  const markSaved = useStore((s) => s.markSaved)
  const folder = useStore((s) => s.projectFolder)
  const widths = useStore((s) => s.panelWidths)

  useAutosave()
  useKeyboard()

  const onSave = useCallback(async () => {
    const json = currentProjectJson()
    if (json && folder) {
      await window.blockout.saveProject(folder, json)
      markSaved()
    }
  }, [folder, markSaved])

  if (!doc) {
    return (
      <div className={`app ${PLATFORM_CLASS}`}>
        <div className="titlebar">
          <span className="app-name">BLOCKOUT</span>
        </div>
        <Welcome />
        <Toasts />
        <HelpOverlay />
      </div>
    )
  }

  return (
    <div className={`app ${PLATFORM_CLASS}`}>
      <div className="titlebar">
        <span className="app-name">BLOCKOUT</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {doc.name}
          {dirty ? ' •' : ''}
        </span>
        <div className="mode-switch">
          <button className={mode === 'stage' ? 'active' : ''} onClick={() => setMode('stage')}>
            STAGE
          </button>
          <button className={mode === 'shoot' ? 'active' : ''} onClick={() => setMode('shoot')}>
            SHOOT
          </button>
          <button className={mode === 'deliver' ? 'active' : ''} onClick={() => setMode('deliver')}>
            DELIVER
          </button>
        </div>
        <button className="btn small" onClick={onSave}>
          Save
        </button>
        <button
          className="btn small"
          title="Help: quick start, how-do-I answers, shortcuts (?)"
          onClick={() => useStore.getState().setHelpOpen(true)}
        >
          ? Help
        </button>
      </div>

      {mode === 'deliver' ? (
        <div className="deliver-layout" style={{ gridTemplateColumns: `1fr ${widths.deliver}px` }}>
          <div className="deliver-preview">
            <Viewport />
          </div>
          <DeliverPanel />
          <PanelResizer side="deliver" />
        </div>
      ) : (
        <div className="main" style={{ gridTemplateColumns: `${widths.left}px 1fr ${widths.right}px` }}>
          <div className="panel">
            <ProjectRail />
            {mode === 'stage' && <Library />}
            <Credits compact />
          </div>
          <div className="center-column">
            <div className="viewport-wrap">
              <Viewport />
            </div>
            {mode === 'shoot' && <Timeline />}
          </div>
          <div className="panel right">
            <Inspector />
          </div>
          <PanelResizer side="left" />
          <PanelResizer side="right" />
        </div>
      )}
      <Toasts />
      <HelpOverlay />
      <BlockingCoach />
    </div>
  )
}
