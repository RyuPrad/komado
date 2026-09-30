// Ink clears the screen when its output reaches the terminal's full height.
// Reserve the last row, and share the app's padding with every screen's sizing.
export function getInkViewport(dimensions = {}) {
  const terminalCols = Math.max(1, Math.floor(dimensions.cols || 80));
  const terminalRows = Math.max(1, Math.floor(dimensions.rows || 24));
  const paddingX = terminalCols < 3 ? 0 : 1;
  return {
    cols: Math.max(1, terminalCols - paddingX * 2),
    rows: Math.max(0, terminalRows - 1),
    paddingX,
  };
}

export function isInkViewportUsable({ cols, rows }) {
  return cols >= 8 && rows >= 3;
}
