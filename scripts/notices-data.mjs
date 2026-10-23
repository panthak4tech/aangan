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

export function noticeKey(notice) {
  return `${notice.name}@${notice.version}@${notice.repository}`;
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

export function normalizeLicenseText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

export function excludeWorkspacePackages(packages, workspacePackageNames) {
  return packages.filter(({ package: crate }) => !workspacePackageNames.has(crate.name));
}

export function renderMarkdown(notices) {
  const sections = notices.map(
    ({ name, version, license, repository, text }) => {
      const longestBacktickRun = Math.max(
        0,
        ...[...text.matchAll(/`+/g)].map(([run]) => run.length),
      );
      const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
      return `## ${name} ${version}\n\nLicense: ${license}\n\nRepository: ${repository}\n\n${fence}text\n${text}\n${fence}`;
    },
  );
  return [
    "# Third-party notices",
    "",
    "Third-party notices. Components bundled in Aangan and their licenses. Aangan itself is MIT licensed (see LICENSE).",
    "",
    ...sections,
    "",
  ].join("\n");
}

export function javascriptNotices(licenseData, projectPackageName, fontNames, readLicenseText) {
  return Object.entries(licenseData).flatMap(([packageKey, metadata]) => {
    const separator = packageKey.lastIndexOf("@");
    const packageName = separator > 0 ? packageKey.slice(0, separator) : packageKey;
    if (packageName === projectPackageName || packageName === "desktop") return [];
    if (!metadata.licenseFile) {
      throw new Error(`No license file found for JavaScript dependency ${packageKey}`);
    }
    const text = normalizeLicenseText(readLicenseText(metadata.licenseFile));
    if (!text) throw new Error(`Empty license file for JavaScript dependency ${packageKey}`);
    return [{
      name: fontNames.get(packageName) ?? packageName,
      version: metadata.version ?? packageKey.slice(separator + 1),
      license: metadata.licenses,
      repository:
        typeof metadata.repository === "string" && metadata.repository.length > 0
          ? metadata.repository
          : `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`,
      text,
    }];
  });
}
