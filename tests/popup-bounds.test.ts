import { describe, expect, it } from 'vitest'
import { calculatePopupResizeBounds, fitPopupSizeToWorkArea } from '../electron/popup-bounds.mjs'

const base = {
  startBounds: { x: 200, y: 120, width: 468, height: 640 },
  startPoint: { x: 668, y: 760 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}

describe('popup resize bounds', () => {
  it('resizes freely from the south-east corner', () => {
    expect(calculatePopupResizeBounds({
      ...base,
      direction: 'se',
      currentPoint: { x: 768, y: 840 },
    })).toEqual({ x: 200, y: 120, width: 568, height: 720 })
  })

  it('keeps the opposite edge fixed when resizing from north-west', () => {
    expect(calculatePopupResizeBounds({
      ...base,
      direction: 'nw',
      startPoint: { x: 200, y: 120 },
      currentPoint: { x: 250, y: 160 },
    })).toEqual({ x: 250, y: 160, width: 418, height: 600 })
  })

  it('enforces the usable minimum size and screen boundary', () => {
    expect(calculatePopupResizeBounds({
      ...base,
      direction: 'nw',
      startPoint: { x: 200, y: 120 },
      currentPoint: { x: 900, y: 900 },
    })).toEqual({ x: 308, y: 520, width: 360, height: 240 })
  })
})

describe('fitPopupSizeToWorkArea', () => {
  it('keeps a saved size when it fits the active display', () => {
    expect(fitPopupSizeToWorkArea({
      width: 720,
      height: 640,
      workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
    })).toEqual({ width: 720, height: 640 })
  })

  it('fits a size saved on a large monitor onto a smaller display', () => {
    expect(fitPopupSizeToWorkArea({
      width: 1800,
      height: 1200,
      workArea: { x: -1366, y: 0, width: 1366, height: 728 },
    })).toEqual({ width: 1342, height: 704 })
  })
})
