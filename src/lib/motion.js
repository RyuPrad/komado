// Exponential approach toward a target - the browser-scroll feel: speed is
// proportional to remaining distance, so motion starts fast and lands softly.
// Time-based (dt/tau), which makes it frame-rate independent: a slow terminal
// that manages fewer frames takes bigger steps and stays on the same curve.
// `snap` (same unit as the values) ends the approach exactly on target, so
// animation loops terminate instead of chasing an asymptote.
export function easeToward(current, target, dt, tau, snap = 0) {
  const d = target - current;
  if (Math.abs(d) <= snap) return target;
  const next = current + d * (1 - Math.exp(-Math.max(0, dt) / tau));
  return Math.abs(target - next) <= snap ? target : next;
}
