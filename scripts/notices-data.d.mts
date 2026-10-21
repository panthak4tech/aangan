export interface Notice {
  name: string;
  version: string;
  license: string;
  repository: string;
  text: string;
}

export interface JavaScriptLicenseMetadata {
  licenseFile?: string;
  version?: string;
  licenses: string;
  repository?: string;
}

export function mergeNotices(...sources: Notice[][]): Notice[];
export function noticeKey(notice: Notice): string;
export function sortNotices(notices: Notice[]): Notice[];
export function filterNotices(notices: Notice[], query: string): Notice[];
export function normalizeLicenseText(text: string): string;
export function javascriptNotices(
  licenseData: Record<string, JavaScriptLicenseMetadata>,
  projectPackageName: string,
  fontNames: Map<string, string>,
  readLicenseText: (path: string) => string,
): Notice[];
