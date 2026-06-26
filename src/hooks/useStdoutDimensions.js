import { useState, useEffect } from 'react';

// Terminal size + live updates on resize. The reader recomputes its viewport
// and re-renders the page at the new width from this.
export function useStdoutDimensions() {
  const read = () => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    const onResize = () => setSize(read());
    process.stdout.on('resize', onResize);
    return () => process.stdout.off('resize', onResize);
  }, []);

  return size;
}
