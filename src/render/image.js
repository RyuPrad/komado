import sharp from 'sharp';
import { renderHalfBlock } from './halfblock.js';
import { renderChafaSymbols } from './chafa.js';
import { logger } from '../lib/logger.js';

export async function imageSize(buffer) {
  const { width = 1, height = 1 } = await sharp(buffer).metadata();
  return { width, height };
}

// Dispatch a buffer to the chosen inline backend, producing { lines, cols, rows }.
// Always falls back to half-block so a chafa hiccup never blanks the reader -
// the same "graceful degradation" idea as your SSR→static fallback.
export async function renderInline(buffer, { cols = 80, backend = 'halfblock' } = {}) {
  if (backend === 'chafa-symbols') {
    try {
      return await renderChafaSymbols(buffer, { cols });
    } catch (err) {
      logger.warn('chafa render failed, falling back to half-block', err);
      return renderHalfBlock(buffer, { cols });
    }
  }
  return renderHalfBlock(buffer, { cols });
}
