// Natural ("human") ordering so page2 < page10 and "Chapter 1.5" sorts sanely.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const naturalCompare = (a, b) => collator.compare(String(a), String(b));

export const naturalSort = (arr, key = (x) => x) =>
  [...arr].sort((a, b) => naturalCompare(key(a), key(b)));
