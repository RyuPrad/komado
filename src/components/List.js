import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { html } from '../html.js';

// Reusable windowed, keyboard-driven list. The parent supplies `renderItem`
// (which must set a `key`) and gets `onSelect`/`onHighlight` callbacks.
// Only the active instance consumes input, so multiple lists can coexist.
export function List({
  items = [],
  onSelect,
  onHighlight,
  renderItem,
  height = 12,
  isActive = true,
  emptyText = 'Nothing here yet.',
}) {
  const [index, setIndex] = useState(0);

  // Keep selection in range as items load/change.
  useEffect(() => {
    setIndex((i) => Math.max(0, Math.min(i, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (items.length) onHighlight?.(items[Math.min(index, items.length - 1)], index);
  }, [index, items]);

  useInput((input, key) => {
    if (!items.length) return;
    if (key.downArrow || input === 'j') setIndex((i) => Math.min(items.length - 1, i + 1));
    else if (key.upArrow || input === 'k') setIndex((i) => Math.max(0, i - 1));
    else if (key.pageDown) setIndex((i) => Math.min(items.length - 1, i + height));
    else if (key.pageUp) setIndex((i) => Math.max(0, i - height));
    else if (input === 'g') setIndex(0);
    else if (input === 'G') setIndex(items.length - 1);
    else if (key.return) onSelect?.(items[index], index);
  }, { isActive });

  if (!items.length) {
    return html`<${Text} dimColor>${emptyText}<//>`;
  }

  // Vertical window centred on the selection.
  const start = Math.max(0, Math.min(index - Math.floor(height / 2), Math.max(0, items.length - height)));
  const slice = items.slice(start, start + height);

  return html`<${Box} flexDirection="column">
    ${slice.map((item, i) => renderItem(item, start + i === index, start + i))}
    ${items.length > height
      ? html`<${Text} key="more" dimColor>  · ${index + 1}/${items.length} ·<//>`
      : null}
  <//>`;
}
