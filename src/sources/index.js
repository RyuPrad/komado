import * as mangadex from './mangadex/index.js';
import * as local from './local/index.js';

// Source registry. Every source implements the same interface:
//   search, getManga, listChapters, getPages, loadPageBuffer
// so the hooks/UI never branch on where a manga comes from.
const sources = { mangadex, local };

export function getSource(sourceId) {
  const source = sources[sourceId];
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  return source;
}

export const SOURCES = sources;
export const REMOTE_SOURCES = Object.values(sources).filter((s) => s.remote);
export const LOCAL_SOURCES = Object.values(sources).filter((s) => !s.remote);
