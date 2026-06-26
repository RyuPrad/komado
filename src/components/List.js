import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

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
  const count = items.length;
  // Clamp on read instead of in an effect, so a shrinking list can't leave the
  // selection out of range (and there's no cascading setState-in-effect).
  const selected = count ? Math.min(index, count - 1) : 0;

  useEffect(() => {
    if (count) onHighlight?.(items[selected], selected);
    // onHighlight is intentionally omitted: callers pass an inline closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, items]);

  useInput((input, key) => {
    if (!count) return;
    if (key.downArrow || input === 'j') setIndex(Math.min(count - 1, selected + 1));
    else if (key.upArrow || input === 'k') setIndex(Math.max(0, selected - 1));
    else if (key.pageDown) setIndex(Math.min(count - 1, selected + height));
    else if (key.pageUp) setIndex(Math.max(0, selected - height));
    else if (input === 'g') setIndex(0);
    else if (input === 'G') setIndex(count - 1);
    else if (key.return) onSelect?.(items[selected], selected);
  }, { isActive });

  if (!count) {
    return <Text dimColor>{emptyText}</Text>;
  }

  // Vertical window centred on the selection.
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), Math.max(0, count - height)));
  const slice = items.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {slice.map((item, i) => renderItem(item, start + i === selected, start + i))}
      {count > height ? (
        <Text key="more" dimColor>{`  · ${selected + 1}/${count} ·`}</Text>
      ) : null}
    </Box>
  );
}
