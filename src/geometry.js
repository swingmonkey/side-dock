'use strict';
/**
 * Pure geometry for the desktop sidebar window: no Electron imports, so the
 * snapping rules can be unit-tested with plain node.
 *
 * Coordinate space is DIP, same as `screen` work areas and `win.getBounds()`.
 * A window is either free (`snap: null`, x/y as dropped) or snapped to one edge
 * (`left`/`right` keep y, `top`/`bottom` keep x).
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Distance from the window rectangle to each screen edge. */
function nearestEdge(bounds, area) {
  const distances = [
    ['left', bounds.x - area.x],
    ['right', area.x + area.width - (bounds.x + bounds.width)],
    ['top', bounds.y - area.y],
    ['bottom', area.y + area.height - (bounds.y + bounds.height)],
  ];
  let best = distances[0];
  for (const entry of distances) {
    if (entry[1] < best[1]) best = entry;
  }
  return { edge: best[0], distance: best[1] };
}

/** Which edge should this drop snap to, or null when it is far from every one. */
function snapEdge(bounds, area, threshold) {
  const nearest = nearestEdge(bounds, area);
  if (nearest.distance > threshold) return null;
  return nearest.edge;
}

/**
 * Resolve the final window rectangle.
 * `anchorX`/`anchorY` are the free-position origin (and the cross-axis anchor
 * when snapped); `width`/`height` are the card's measured size.
 */
function resolveBounds(state, area) {
  const width = Math.round(clamp(state.width, 1, area.width));
  const height = Math.round(clamp(state.height, 1, area.height));
  const anchorX = Number.isFinite(state.anchorX) ? state.anchorX : area.x;
  const anchorY = Number.isFinite(state.anchorY) ? state.anchorY : area.y;
  let x = anchorX;
  let y = anchorY;
  if (state.snap === 'left') x = area.x;
  else if (state.snap === 'right') x = area.x + area.width - width;
  else if (state.snap === 'top') y = area.y;
  else if (state.snap === 'bottom') y = area.y + area.height - height;
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - height)),
    width,
    height,
  };
}

module.exports = { clamp, nearestEdge, snapEdge, resolveBounds };
