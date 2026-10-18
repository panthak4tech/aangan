import * as React from "react";
import { AlertOctagon, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "./display";
import { Stepper } from "./interactive";

/* ---------- EmptyState ---------- */
export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Buttons or links shown below the text. */
  action?: React.ReactNode;
  size?: "sm" | "md";
}
/** Placeholder for a list or panel with nothing in it yet. */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(({ title, description, icon, action, size = "md", className, ...props }, ref) => (
  <div ref={ref} className={cn("flex flex-col items-center gap-3 rounded-xl border border-dashed text-center", size === "sm" ? "p-6" : "p-10", className)} {...props}>
    <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&>svg]:size-5" aria-hidden>{icon ?? <Inbox />}</span>
    <div className="flex max-w-sm flex-col gap-1">
      <p className="font-display text-base font-semibold">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>
));
EmptyState.displayName = "EmptyState";

/* ---------- ErrorState ---------- */
export interface ErrorStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional technical detail, shown in monospace. */
  detail?: string;
  action?: React.ReactNode;
}
/** Something failed; explains what and offers a way forward. */
export const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(({ title, description, detail, action, className, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn("flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-10 text-center", className)} {...props}>
    <span className="flex size-12 items-center justify-center rounded-full bg-destructive/15 text-destructive" aria-hidden><AlertOctagon className="size-5" /></span>
    <div className="flex max-w-md flex-col gap-1">
      <p className="font-display text-base font-semibold">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {detail && <code className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{detail}</code>}
    {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>
));
ErrorState.displayName = "ErrorState";

/* ---------- WizardShell ---------- */
export interface WizardShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  steps: string[];
  /** zero-based index of the current step */
  current: number;
  /** Footer buttons, e.g. Back / Continue. */
  footer?: React.ReactNode;
}
/** Frame for multi-step flows: title, step indicator, content and footer. */
export const WizardShell = React.forwardRef<HTMLDivElement, WizardShellProps>(({ title, description, steps, current, footer, className, children, ...props }, ref) => (
  <Card ref={ref} padding="none" className={cn("flex flex-col overflow-hidden", className)} {...props}>
    <header className="flex flex-col gap-4 border-b p-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">Step {current + 1} of {steps.length}</p>
        <h2 className="font-display text-xl font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <Stepper steps={steps} current={current} />
    </header>
    <div className="flex-1 p-6">{children}</div>
    {footer && <footer className="flex items-center justify-end gap-2 border-t bg-muted/40 px-6 py-4">{footer}</footer>}
  </Card>
));
WizardShell.displayName = "WizardShell";
