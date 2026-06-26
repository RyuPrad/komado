// TUI flavour of your server catchAsync. Instead of forwarding to next(err),
// it resolves a { data, error } result so hooks can drop straight into state
// without a try/catch at every call site (and never crash the render loop).
export function catchAsync(fn) {
  return async (...args) => {
    try {
      return { data: await fn(...args), error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
}
