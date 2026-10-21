export interface Notice {
  name: string;
  version: string;
  license: string;
  repository: string;
  text: string;
}

export function mergeNotices(...sources: Notice[][]): Notice[];
export function sortNotices(notices: Notice[]): Notice[];
export function filterNotices(notices: Notice[], query: string): Notice[];
