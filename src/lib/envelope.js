// Consistent { data, pagination, meta } shape across every source, exactly like
// your API envelope. Sources return this so hooks/UI are source-agnostic.
export function envelope(data, { pagination = null, meta = {} } = {}) {
  return { data, pagination, meta };
}

export function paginate({ offset = 0, limit = 0, total = 0 } = {}) {
  return {
    offset,
    limit,
    total,
    hasMore: total > 0 ? offset + limit < total : false,
  };
}
