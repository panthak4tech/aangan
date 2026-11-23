import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearRuntimeLogs,
  copyRuntimeDiagnostics,
  getRuntimeEndpoint,
  getRuntimeLogs,
  getRuntimeStatus,
  listRuntimes,
  listenRuntimeLogs,
  listenRuntimeState,
  startRuntime,
  stopRuntime,
} from "@/api/api";
import type { RuntimeCatalog, RuntimeEndpoint, RuntimeLogEntry, RuntimeStatus } from "@/api/types";
import { Button } from "@/components/primitives/button";
import { Progress } from "@/components/ui/display";
import { useDownloads } from "@/downloads/useDownloads";
import { en } from "@/i18n/en";

function mergeRuntimeLogs(
  current: RuntimeLogEntry[],
  incoming: RuntimeLogEntry[],
): RuntimeLogEntry[] {
  const entries = new Map<number, RuntimeLogEntry>();
  for (const entry of current) entries.set(entry.sequence, entry);
  for (const entry of incoming) entries.set(entry.sequence, entry);
  return [...entries.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-5000);
}

export function RuntimeRunCard({
  modelId,
  context,
}: {
  modelId: string;
  context: number;
}) {
  const downloads = useDownloads();
  const download = downloads.byId(modelId);
  const [status, setStatus] = useState<RuntimeStatus>({
    state: { kind: "stopped" },
    port: null,
    apiKeyVisible: false,
  });
  const [endpoint, setEndpoint] = useState<RuntimeEndpoint | null>(null);
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const logPaneRef = useRef<HTMLPreElement>(null);
  const statusEventVersion = useRef(0);
  const logClearVersion = useRef(0);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [ctx, setCtx] = useState(context);
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimeCatalog | null>(null);
  const [runtimeCatalogState, setRuntimeCatalogState] = useState<"loading" | "loaded" | "error">("loading");
  const [runtimeCatalogError, setRuntimeCatalogError] = useState<string | null>(null);
  const [runtimeCatalogReload, setRuntimeCatalogReload] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unlistenFunctions: Array<() => void> = [];
    const registerListener = (registration: Promise<() => void>) => {
      void registration
        .then((unlisten) => {
          if (active) unlistenFunctions.push(unlisten);
          else unlisten();
        })
        .catch((reason: unknown) => {
          if (active) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        });
    };
    const stateRegistration = listenRuntimeState((next) => {
        if (!active) return;
        statusEventVersion.current += 1;
        setStatus(next);
    });
    registerListener(stateRegistration);
    const loadInitialStatus = () => {
        if (!active) return;
        const version = statusEventVersion.current;
        void getRuntimeStatus()
          .then((next) => {
            if (active && statusEventVersion.current === version) setStatus(next);
          })
          .catch((reason: unknown) => {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
          });
    };
    void stateRegistration.then(loadInitialStatus, loadInitialStatus);

    const logRegistration = listenRuntimeLogs((entry) => {
        if (active) setLogs((current) => mergeRuntimeLogs(current, [entry]));
    });
    registerListener(logRegistration);
    const loadInitialLogs = () => {
        if (!active) return;
        const clearVersion = logClearVersion.current;
        void getRuntimeLogs()
          .then((snapshot) => {
            if (active && logClearVersion.current === clearVersion) {
              setLogs((current) => mergeRuntimeLogs(current, snapshot));
            }
          })
          .catch((reason: unknown) => {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
          });
    };
    void logRegistration.then(loadInitialLogs, loadInitialLogs);
    return () => {
      active = false;
      unlistenFunctions.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let active = true;
    setRuntimeCatalogState("loading");
    setRuntimeCatalogError(null);
    void listRuntimes()
        .then((catalog) => {
          if (!active) return;
          setRuntimeCatalog(catalog);
          setRuntimeCatalogState("loaded");
        })
        .catch((reason: unknown) => {
          if (!active) return;
          setRuntimeCatalog(null);
          setRuntimeCatalogError(reason instanceof Error ? reason.message : String(reason));
          setRuntimeCatalogState("error");
        });
    return () => {
        active = false;
    };
  }, [runtimeCatalogReload]);

  useEffect(() => {
    if (!paused && logPaneRef.current) {
      logPaneRef.current.scrollTop = logPaneRef.current.scrollHeight;
    }
  }, [logs, paused]);

  useEffect(() => {
    if (status.state.kind === "ready") {
      void getRuntimeEndpoint().then(setEndpoint);
    } else {
      setEndpoint(null);
    }
  }, [status.state.kind]);

  const filteredLogs = useMemo(
    () => logs
      .map((entry) => entry.line)
      .filter((line) => line.toLowerCase().includes(filter.toLowerCase())),
    [filter, logs],
  );
  const downloaded = download?.state.kind === "done";
  const installedRuntimes = runtimeCatalog?.runtimes.flatMap((runtime) => runtime.installed) ?? [];
  const runtimeInstalled = installedRuntimes.length > 0;
  const defaultRuntime = runtimeCatalog?.defaultRuntime;
  const hasDefaultRuntime = Boolean(defaultRuntime && installedRuntimes.some((runtime) =>
    runtime.runtimeId === defaultRuntime.runtimeId
      && runtime.version === defaultRuntime.version
      && runtime.variant === defaultRuntime.variant
  ));
  const canStart = downloaded && hasDefaultRuntime;
  const stateKind = status.state.kind;

  const start = async () => {
    setWorking(true);
    setError(null);
    const version = statusEventVersion.current;
    try {
      const next = await startRuntime(modelId, ctx);
      if (statusEventVersion.current === version) {
        statusEventVersion.current += 1;
        setStatus(next);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const stop = async () => {
    setWorking(true);
    setError(null);
    const version = statusEventVersion.current;
    try {
      const next = await stopRuntime();
      if (statusEventVersion.current === version) {
        statusEventVersion.current += 1;
        setStatus(next);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
  };

  const copyDiagnostics = async () => {
    const diagnostics = await copyRuntimeDiagnostics();
    await copy(diagnostics);
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Run on this PC">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Run on this PC</h3>
          <p className="text-xs text-muted-foreground">
            Runs only on this PC. Stops automatically when Aangan closes.
          </p>
        </div>
        {stateKind === "ready" ? (
          <span className="text-xs font-medium text-fit-great">Running on this PC only</span>
        ) : (
          <span className="text-xs text-muted-foreground">{stateKind}</span>
        )}
      </div>

      {runtimeCatalogState === "error" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {en.views.models.runtimeCatalogLoadFailed(runtimeCatalogError ?? "")}
          </p>
          <Button size="sm" variant="outline" onClick={() => setRuntimeCatalogReload((value) => value + 1)}>
            {en.views.models.retry}
          </Button>
        </div>
      )}
      {runtimeCatalogState === "loaded" && !runtimeInstalled && (
        <p className="text-sm text-muted-foreground">No runtime is installed. Open Runtimes in Settings to install one.</p>
      )}
      {runtimeCatalogState === "loaded" && runtimeInstalled && !hasDefaultRuntime && (
        <p className="text-sm text-muted-foreground">{en.views.models.selectDefaultRuntime}</p>
      )}
      {!downloaded && (
        <p className="text-sm text-muted-foreground">Download this model before starting it.</p>
      )}
      {stateKind === "starting" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Loading model... this can take a minute for large models</p>
          <Progress value={100} label="Starting llama-server" />
        </div>
      )}
      {endpoint && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <code className="break-all text-foreground">{endpoint.baseUrl}</code>
            <Button size="sm" variant="outline" onClick={() => void copy(endpoint.baseUrl)}>Copy endpoint</Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">API key hidden</span>
            <Button size="sm" variant="outline" onClick={() => void copy(endpoint.key)}>Copy key</Button>
          </div>
        </div>
      )}
      {stateKind === "failed" && status.state.kind === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          llama-server failed
          {status.state.exitCode !== null ? ` (exit code ${status.state.exitCode})` : ""}.
        </p>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
        <label className="mt-2 flex items-center gap-2 text-muted-foreground">
          Context
          <input
            className="w-28 rounded border border-border bg-background px-2 py-1 text-foreground"
            type="number"
            min={128}
            max={131072}
            value={ctx}
            onChange={(event) => setCtx(Number(event.target.value) || 4096)}
          />
        </label>
      </details>

      <div className="flex flex-wrap gap-2">
        {(stateKind === "stopped" || stateKind === "failed") && (
          <Button disabled={!canStart || working} onClick={() => void start()}>
            Start
          </Button>
        )}
        {(stateKind === "starting" || stateKind === "ready" || stateKind === "stopping") && (
          <Button variant="outline" disabled={working} onClick={() => void stop()}>
            Stop
          </Button>
        )}
      </div>

      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">Logs</summary>
        <div className="mt-3 flex flex-col gap-2">
          <input
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter logs"
            aria-label="Filter logs"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setPaused((value) => !value)}>
              {paused ? "Resume" : "Pause"} auto-scroll
            </Button>
            <Button size="sm" variant="outline" onClick={() => void copy(filteredLogs.join("\n"))}>Copy</Button>
            <Button size="sm" variant="outline" onClick={() => {
              logClearVersion.current += 1;
              setLogs([]);
              void clearRuntimeLogs();
            }}>Clear</Button>
            <Button size="sm" variant="outline" onClick={() => void copyDiagnostics()}>
              Copy diagnostics (no secrets)
            </Button>
          </div>
          <pre ref={logPaneRef} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs text-foreground">
            {filteredLogs.join("\n")}
          </pre>
        </div>
      </details>
    </section>
  );
}
