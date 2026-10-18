import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

export function ErrorState({
  title,
  body,
  actions,
  footer,
}: {
  title: string;
  body: string;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 rounded-xl border border-destructive/40 bg-destructive/5 p-8 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-display text-lg font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {actions && <div className="flex flex-wrap justify-center gap-3">{actions}</div>}
      {footer}
    </div>
  );
}
