export const POPUP_MIN_WIDTH = 360
export const POPUP_MIN_HEIGHT = 240

const DIRECTIONS = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'])

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function fitPopupSizeToWorkArea({
  width,
  height,
  workArea,
  margin = 12,
  minWidth = POPUP_MIN_WIDTH,
  minHeight = POPUP_MIN_HEIGHT,
}) {
  const availableWidth = Math.max(1, Number(workArea?.width) - margin * 2)
  const availableHeight = Math.max(1, Number(workArea?.height) - margin * 2)
  return {
    width: Math.round(Math.min(availableWidth, Math.max(minWidth, Number(width) || minWidth))),
    height: Math.round(Math.min(availableHeight, Math.max(minHeight, Number(height) || minHeight))),
  }
}

export function clampPositionToWorkArea({ bounds, workArea }) {
  const width = Math.max(1, Number(bounds?.width) || 1)
  const height = Math.max(1, Number(bounds?.height) || 1)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  return {
    x: Math.round(Math.max(workArea.x, Math.min(Number(bounds?.x) || 0, maxX))),
    y: Math.round(Math.max(workArea.y, Math.min(Number(bounds?.y) || 0, maxY))),
  }
}

export function calculatePopupResizeBounds({
  direction,
  startBounds,
  startPoint,
  currentPoint,
  workArea,
  minWidth = POPUP_MIN_WIDTH,
  minHeight = POPUP_MIN_HEIGHT,
}) {
  if (!DIRECTIONS.has(direction)) return { ...startBounds }

  const dx = Number(currentPoint.x) - Number(startPoint.x)
  const dy = Number(currentPoint.y) - Number(startPoint.y)
  const workLeft = workArea.x
  const workTop = workArea.y
  const workRight = workArea.x + workArea.width
  const workBottom = workArea.y + workArea.height

  let left = startBounds.x
  let top = startBounds.y
  let right = startBounds.x + startBounds.width
  let bottom = startBounds.y + startBounds.height

  if (direction.includes('e')) {
    right = clamp(right + dx, left + minWidth, workRight)
  }
  if (direction.includes('w')) {
    left = clamp(left + dx, workLeft, right - minWidth)
  }
  if (direction.includes('s')) {
    bottom = clamp(bottom + dy, top + minHeight, workBottom)
  }
  if (direction.includes('n')) {
    top = clamp(top + dy, workTop, bottom - minHeight)
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  }
}
