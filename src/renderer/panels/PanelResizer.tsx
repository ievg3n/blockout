/**
 * Draggable edge between a side panel and the viewport. Drag to resize,
 * double-click to restore the default width, or focus it and use ←/→.
 * Widths live in the store (persisted to localStorage, never in the doc).
 */

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useStore, PANEL_DEFAULTS } from '../store'

export function PanelResizer({ side }: { side: 'left' | 'right' | 'deliver' }): JSX.Element {
  const width = useStore((s) => s.panelWidths[side])
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  // Left panel grows as the pointer moves right; right-docked panels grow
  // as it moves left.
  const dir = side === 'left' ? 1 : -1

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = width
    document.body.classList.add('resizing-panels')
    const move = (ev: PointerEvent): void => setPanelWidth(side, startW + (ev.clientX - startX) * dir)
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing-panels')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') setPanelWidth(side, width - step * dir)
    else if (e.key === 'ArrowRight') setPanelWidth(side, width + step * dir)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      className={`panel-resizer ${side === 'left' ? 'left' : 'right'}`}
      style={side === 'left' ? { left: width - 3 } : { right: width - 3 }}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side === 'left' ? 'left' : 'right'} panel`}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setPanelWidth(side, PANEL_DEFAULTS[side])}
      onKeyDown={onKeyDown}
    />
  )
}
