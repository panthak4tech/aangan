import * as React from "react";
import { Check, X, CheckCircle2, AlertTriangle, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------- Tabs ---------- */
export interface TabItem { value: string; label: string; content: React.ReactNode }
export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  variant?: "underline" | "pill";
}
/** Accessible tabs with arrow-key navigation. */
export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ items, value, defaultValue, onValueChange, variant = "underline", className, ...props }, ref) => {
    const [inner, setInner] = React.useState(defaultValue ?? items[0]?.value);
    const active = value ?? inner;
    const id = React.useId();
    const select = (v: string) => { setInner(v); onValueChange?.(v); };
    const onKey = (e: React.KeyboardEvent, i: number) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
      select(items[n].value);
      document.getElementById(`${id}-tab-${n}`)?.focus();
    };
    return (
      <div ref={ref} className={cn("flex flex-col gap-4", className)} {...props}>
        <div role="tablist" className={cn("flex gap-1", variant === "underline" ? "border-b" : "w-fit rounded-lg bg-muted p-1")}>
          {items.map((t, i) => {
            const on = t.value === active;
            return (
              <button key={t.value} id={`${id}-tab-${i}`} role="tab" type="button" aria-selected={on} aria-controls={`${id}-panel-${i}`}
                tabIndex={on ? 0 : -1} onClick={() => select(t.value)} onKeyDown={(e) => onKey(e, i)}
                className={cn("px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  variant === "underline"
                    ? cn("-mb-px border-b-2", on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
                    : cn("rounded-md", on ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"))}>
                {t.label}
              </button>
            );
          })}
        </div>
        {items.map((t, i) => (
          <div key={t.value} id={`${id}-panel-${i}`} role="tabpanel" aria-labelledby={`${id}-tab-${i}`} hidden={t.value !== active}>
            {t.content}
          </div>
        ))}
      </div>
    );
  },
);
Tabs.displayName = "Tabs";

/* ---------- Dialog ---------- */
export interface DialogProps extends Omit<React.DialogHTMLAttributes<HTMLDialogElement>, "title"> {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}
/** Modal built on native <dialog> (focus trap + Esc for free). */
export const Dialog = React.forwardRef<HTMLDialogElement, DialogProps>(
  ({ open, onClose, title, description, footer, size = "md", className, children, ...props }, ref) => {
    const inner = React.useRef<HTMLDialogElement>(null);
    React.useImperativeHandle(ref, () => inner.current as HTMLDialogElement);
    React.useEffect(() => {
      const d = inner.current;
      if (!d) return;
      if (open && !d.open) d.showModal();
      if (!open && d.open) d.close();
    }, [open]);
    return (
      <dialog ref={inner} onClose={onClose} aria-labelledby="dlg-title"
        className={cn("m-auto w-full rounded-xl border bg-popover p-0 text-popover-foreground shadow-md backdrop:bg-foreground/40",
          { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" }[size], className)} {...props}>
        <div className="flex items-start justify-between gap-4 p-6 pb-2">
          <div>
            <h2 id="dlg-title" className="font-display text-lg font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-2 text-sm">{children}</div>
        {footer && <div className="flex justify-end gap-2 p-6 pt-4">{footer}</div>}
      </dialog>
    );
  },
);
Dialog.displayName = "Dialog";

/* ---------- Toast ---------- */
const toastIcons = { info: Info, success: CheckCircle2, warning: AlertTriangle, destructive: XCircle };
const toastTone = { info: "text-info", success: "text-success", warning: "text-warning", destructive: "text-destructive" };
export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof toastIcons;
  title: string;
  description?: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
}
/** Transient notification. Place inside a fixed corner container. */
export const Toast = React.forwardRef<HTMLDivElement, ToastProps>(({ variant = "info", title, description, onDismiss, action, className, ...props }, ref) => {
  const Icon = toastIcons[variant];
  return (
    <div ref={ref} role="status" aria-live="polite" className={cn("flex w-full max-w-sm items-start gap-3 rounded-lg border bg-popover p-4 shadow-md animate-in fade-in slide-in-from-bottom-2", className)} {...props}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", toastTone[variant])} aria-hidden />
      <div className="flex-1 text-sm">
        <p className="font-medium">{title}</p>
        {description && <p className="text-muted-foreground">{description}</p>}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-2 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {action.label}
          </button>
        )}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
});
Toast.displayName = "Toast";

/* ---------- Stepper ---------- */
export interface StepperProps extends React.HTMLAttributes<HTMLOListElement> {
  steps: string[];
  /** zero-based index of the current step */
  current: number;
  orientation?: "horizontal" | "vertical";
}
/** Progress through a multi-step flow. */
export const Stepper = React.forwardRef<HTMLOListElement, StepperProps>(({ steps, current, orientation = "horizontal", className, ...props }, ref) => (
  <ol ref={ref} className={cn("flex", orientation === "horizontal" ? "items-center gap-2" : "flex-col gap-3", className)} {...props}>
    {steps.map((s, i) => {
      const state = i < current ? "done" : i === current ? "current" : "upcoming";
      return (
        <li key={s} aria-current={state === "current" ? "step" : undefined} className={cn("flex items-center gap-2", orientation === "horizontal" && "flex-1")}>
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            state === "done" && "bg-primary text-primary-foreground",
            state === "current" && "border-2 border-primary text-primary",
            state === "upcoming" && "bg-muted text-muted-foreground")}>
            {state === "done" ? <Check className="size-3.5" aria-hidden /> : i + 1}
          </span>
          <span className={cn("text-sm", state === "upcoming" ? "text-muted-foreground" : "font-medium")}>{s}</span>
          {orientation === "horizontal" && i < steps.length - 1 && <span className={cn("h-px flex-1", i < current ? "bg-primary" : "bg-border")} aria-hidden />}
        </li>
      );
    })}
  </ol>
));
Stepper.displayName = "Stepper";
