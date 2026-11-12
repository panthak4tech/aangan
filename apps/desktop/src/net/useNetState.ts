import { useCallback, useEffect, useState } from "react";
import {
  getNetworkState,
  listenNetworkState,
  setOfflineMode as saveOfflineMode,
} from "@/api/api";
import type { NetworkState } from "@/api/types";

export function useNetState() {
  const [state, setState] = useState<NetworkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    let unlisten: (() => void) | undefined;

    void listenNetworkState((nextState) => {
      if (!mounted) return;
      receivedEvent = true;
      setState(nextState);
      setError(null);
    })
      .then((stopListening) => {
        if (mounted) unlisten = stopListening;
        else stopListening();
      })
      .catch((cause: unknown) => {
        if (mounted) setError(errorMessage(cause));
      });

    void getNetworkState()
      .then((nextState) => {
        if (!mounted) return;
        if (!receivedEvent) setState(nextState);
      })
      .catch((cause: unknown) => {
        if (mounted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const updateOfflineMode = useCallback(async (offlineMode: boolean) => {
    try {
      const nextState = await saveOfflineMode(offlineMode);
      setState(nextState);
      setError(null);
      return nextState;
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  }, []);

  return { state, loading, error, updateOfflineMode };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
