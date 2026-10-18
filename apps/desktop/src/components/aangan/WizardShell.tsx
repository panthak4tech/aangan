import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WizardShellProps {
  stepIndex: number;
  stepCount: number;
  stepLabel: string;
  title: string;
  description?: string | undefined;
  children?: ReactNode;
  footer?: ReactNode | undefined;
}

export function WizardShell({
  stepIndex,
  stepCount,
  stepLabel,
  title,
  description,
  children,
  footer,
}: WizardShellProps) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-xl flex-col gap-8 rounded-2xl border border-border bg-card p-10 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {stepLabel}
          </span>
          <div className="flex gap-1.5" aria-hidden>
            {Array.from({ length: stepCount }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-8 rounded-full bg-muted transition-colors",
                  i <= stepIndex && "bg-primary",
                )}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-card-foreground">
            {title}
          </h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
        {footer && <div className="flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}
