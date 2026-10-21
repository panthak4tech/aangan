export function mergeNotices(...sources) {
  const merged = new Map();

  for (const notice of sources.flat()) {
    const key = `${notice.name}\0${notice.version}\0${notice.repository}`;
    const existing = merged.get(key);
    if (existing && (existing.license !== notice.license || existing.text !== notice.text)) {
      throw new Error(`Conflicting license notices for ${notice.name} ${notice.version}`);
    }
    if (!existing) merged.set(key, notice);
  }

  return [...merged.values()];
}

export function sortNotices(notices) {
  return [...notices].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en") ||
      left.version.localeCompare(right.version, "en") ||
      left.repository.localeCompare(right.repository, "en"),
  );
}

export function filterNotices(notices, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return notices;
  return notices.filter((notice) =>
    [notice.name, notice.version, notice.license, notice.repository]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}
