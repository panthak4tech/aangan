import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  cancelDownload,
  listDownloads,
  listenDownloadProgress,
  pauseDownload,
  resumeDownload,
  startDownload,
} from "@/api/api";
import type { DownloadProgress, HardwareProfile } from "@/api/types";

export function percent(progress: Pick<DownloadProgress, "done" | "total">): number {
  if (!Number.isFinite(progress.total) || progress.total <= 0) return 0;
  if (!Number.isFinite(progress.done)) return 0;
  return Math.min(100, Math.max(0, (progress.done / progress.total) * 100));
}

export function isActive(progress: DownloadProgress): boolean {
  return progress.state.kind === "queued"
    || progress.state.kind === "downloading"
    || progress.state.kind === "verifying";
}

export interface DownloadsController {
  list: DownloadProgress[];
  active: DownloadProgress[];
  byId: (id: string) => DownloadProgress | undefined;
  error: string | null;
  start: (modelId: string, profile: HardwareProfile, context: number) => Promise<DownloadProgress>;
  pause: (id: string) => Promise<DownloadProgress>;
  resume: (id: string) => Promise<DownloadProgress>;
  cancel: (id: string, deletePartial: boolean) => Promise<DownloadProgress>;
  forget: (id: string) => void;
}

const DownloadsContext = createContext<DownloadsController | null>(null);

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const downloads = useDownloadController();
  return <DownloadsContext.Provider value={downloads}>{children}</DownloadsContext.Provider>;
}

export function useDownloads(): DownloadsController {
  const downloads = useContext(DownloadsContext);
  if (!downloads) {
    throw new Error("useDownloads must be used within DownloadsProvider.");
  }
  return downloads;
}

function useDownloadController(): DownloadsController {
  const [items, setItems] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const eventVersions = useRef(new Map<string, number>());
  const attempts = useRef(new Map<string, number>());
  const forgottenIds = useRef(new Set<string>());

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stopListening = await listenDownloadProgress((progress) => {
          if (mounted && !forgottenIds.current.has(progress.id)) {
            eventVersions.current.set(progress.id, (eventVersions.current.get(progress.id) ?? 0) + 1);
            setItems((previous) => ({ ...previous, [progress.id]: progress }));
          }
        });
        if (mounted) unlisten = stopListening;
        else stopListening();
      } catch (reason) {
        if (mounted) setError(errorMessage(reason));
      }

      try {
        const initial = await listDownloads();
        if (mounted) {
          setItems((previous) => ({
            ...Object.fromEntries(initial
              .filter((progress) => !forgottenIds.current.has(progress.id))
              .map((progress) => [progress.id, progress])),
            ...previous,
          }));
        }
      } catch (reason) {
        if (mounted) setError(errorMessage(reason));
      }
    })();

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const list = useMemo(() => Object.values(items).sort((left, right) => {
    const activeOrder = Number(isActive(right)) - Number(isActive(left));
    return activeOrder || left.id.localeCompare(right.id);
  }), [items]);
  const runCommand = async (
    id: string,
    attempt: number,
    command: () => Promise<DownloadProgress>,
  ): Promise<DownloadProgress> => {
    const version = eventVersions.current.get(id) ?? 0;
    const progress = await command();
    if (
      attempts.current.get(id) === attempt
      && (eventVersions.current.get(id) ?? 0) === version
    ) {
      setItems((previous) => ({ ...previous, [id]: progress }));
    }
    return progress;
  };
  const nextAttempt = (id: string) => {
    const attempt = (attempts.current.get(id) ?? 0) + 1;
    attempts.current.set(id, attempt);
    return attempt;
  };
  const forget = (id: string) => {
    forgottenIds.current.add(id);
    nextAttempt(id);
    eventVersions.current.set(id, (eventVersions.current.get(id) ?? 0) + 1);
    setItems((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  };
  return {
    list,
    active: list.filter(isActive),
    byId: (id: string) => items[id],
    error,
    start: (modelId: string, profile: HardwareProfile, context: number) => {
      forgottenIds.current.delete(modelId);
      const attempt = nextAttempt(modelId);
      eventVersions.current.set(modelId, (eventVersions.current.get(modelId) ?? 0) + 1);
      return runCommand(modelId, attempt, () => startDownload(modelId, profile, context));
    },
    pause: (id: string) => {
      const attempt = nextAttempt(id);
      return runCommand(id, attempt, () => pauseDownload(id));
    },
    resume: (id: string) => {
      const attempt = nextAttempt(id);
      return runCommand(id, attempt, () => resumeDownload(id));
    },
    cancel: async (id: string, deletePartial: boolean) => {
      const attempt = nextAttempt(id);
      const progress = await runCommand(id, attempt, () => cancelDownload(id, deletePartial));
      if (
        attempts.current.get(id) === attempt
        && deletePartial
        && progress.state.kind === "cancelled"
      ) {
        forget(id);
      }
      return progress;
    },
    forget,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
