import { describe, it, expect, vi } from 'vitest';
import { listAllChapters } from '../src/sources/index.js';
import { envelope, paginate } from '../src/lib/envelope.js';

const ch = (id, number, volume = null) => ({ id, number, volume });

// A source whose chapter feed spans several pages, shaped exactly like the
// real ones: { data, pagination } envelopes.
function pagedSource(pages, total) {
  return {
    listChapters: vi.fn(async (_mangaId, { offset, limit }) => {
      const page = pages[offset / limit] || [];
      return envelope(page, { pagination: paginate({ offset, limit, total }) });
    }),
  };
}

describe('listAllChapters', () => {
  it('walks every page and concatenates the chapters', async () => {
    const source = pagedSource(
      [
        [ch('a', '1'), ch('b', '2'), ch('c', '3')],
        [ch('c-dup', '3'), ch('d', null), ch('e', null)],
        [ch('f', '4')],
      ],
      7,
    );
    const all = await listAllChapters(source, 'm1', { pageSize: 3 });

    expect(source.listChapters).toHaveBeenCalledTimes(3);
    expect(source.listChapters.mock.calls.map(([, o]) => o.offset)).toEqual([0, 3, 6]);
    // The duplicate scanlation of ch.3 straddling the page boundary is dropped;
    // number-less chapters (oneshots) are never deduped against each other.
    expect(all.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('keeps same-numbered chapters from different volumes', async () => {
    const source = pagedSource([[ch('v1', '1', '1'), ch('v2', '1', '2')]], 2);
    const all = await listAllChapters(source, 'm1', { pageSize: 10 });
    expect(all.map((c) => c.id)).toEqual(['v1', 'v2']);
  });

  it('stops after a single page when there is no more data', async () => {
    const source = pagedSource([[ch('a', '1')]], 1);
    const all = await listAllChapters(source, 'm1', { pageSize: 500 });
    expect(source.listChapters).toHaveBeenCalledTimes(1);
    expect(all).toHaveLength(1);
  });

  it('respects the maxPages safety cap on a runaway feed', async () => {
    const source = {
      listChapters: vi.fn(async (_id, { offset, limit }) =>
        envelope([ch(`c${offset}`, String(offset))], {
          pagination: paginate({ offset, limit, total: 1_000_000 }),
        })),
    };
    const all = await listAllChapters(source, 'm1', { pageSize: 1, maxPages: 2 });
    expect(source.listChapters).toHaveBeenCalledTimes(2);
    expect(all).toHaveLength(2);
  });

  it('passes language and signal through to the source', async () => {
    const source = pagedSource([[ch('a', '1')]], 1);
    const ctrl = new AbortController();
    await listAllChapters(source, 'm1', { language: 'fr', signal: ctrl.signal });
    const [, opts] = source.listChapters.mock.calls[0];
    expect(opts.language).toBe('fr');
    expect(opts.signal).toBe(ctrl.signal);
  });
});
