import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Toast } from "./interactive";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  variant?: "info" | "success" | "warning" | "destructive";
  action?: ToastAction;
}

interface ToastEntry extends ToastOptions {
  id: number;
  title: string;
}

type ToastFunction = (title: string, options?: ToastOptions) => void;

const ToastContext = createContext<ToastFunction | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<ToastEntry | null>(null);
  const nextId = useRef(0);
  const toast = useCallback<ToastFunction>((title, options) => {
    nextId.current += 1;
    setEntry({ id: nextId.current, title, ...options });
  }, []);

  useEffect(() => {
    if (!entry || entry.variant === "destructive") return;
    const id = window.setTimeout(() => {
      setEntry((current) => (current?.id === entry.id ? null : current));
    }, 6000);
    return () => window.clearTimeout(id);
  }, [entry]);

  const dismiss = useCallback(() => setEntry(null), []);
  const runAction = useCallback(() => {
    if (!entry?.action) return;
    entry.action.onClick();
    setEntry(null);
  }, [entry]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
        {entry && (
          <Toast
            key={entry.id}
            variant={entry.variant}
            title={entry.title}
            action={entry.action ? { label: entry.action.label, onClick: runAction } : undefined}
            onDismiss={dismiss}
          />
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFunction {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within ToastProvider");
  return toast;
}
