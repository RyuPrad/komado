export function truncate(str, max) {
  const s = String(str ?? '');
  if (max <= 1 || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

// Compact relative time ("3h ago") in LOCAL time, anchored to now.
export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
