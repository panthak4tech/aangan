import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------- Card ---------- */
export const cardVariants = cva("rounded-xl border bg-card text-card-foreground", {
  variants: {
    variant: { default: "shadow-xs", elevated: "shadow-md border-transparent", muted: "bg-muted border-transparent" },
    padding: { none: "", sm: "p-4", md: "p-6" },
  },
  defaultVariants: { variant: "default", padding: "md" },
});
export interface CardProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}
/** Surface container. */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, variant, padding, ...props }, ref) => (
  <div ref={ref} className={cn(cardVariants({ variant, padding }), className)} {...props} />
));
Card.displayName = "Card";

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}
export const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(({ className, ...props }, ref) => (
  <h3 ref={ref} className={cn("font-display text-lg font-semibold tracking-tight", className)} {...props} />
));
CardTitle.displayName = "CardTitle";

export interface CardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}
export const CardDescription = React.forwardRef<HTMLParagraphElement, CardDescriptionProps>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

/* ---------- Badge ---------- */
export const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      neutral: "bg-muted text-muted-foreground",
      primary: "bg-primary text-primary-foreground",
      success: "bg-success/15 text-success",
      warning: "bg-warning/20 text-warning-foreground dark:text-warning",
      destructive: "bg-destructive/15 text-destructive",
      info: "bg-info/15 text-info",
      outline: "border text-foreground",
    },
  },
  defaultVariants: { variant: "neutral" },
});
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
/** Compact status label. */
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = "Badge";

/* ---------- Alert ---------- */
const alertIcons = { info: Info, success: CheckCircle2, warning: AlertTriangle, destructive: XCircle };
export const alertVariants = cva("flex gap-3 rounded-lg border p-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0", {
  variants: {
    variant: {
      info: "border-info/30 bg-info/10 [&>svg]:text-info",
      success: "border-success/30 bg-success/10 [&>svg]:text-success",
      warning: "border-warning/40 bg-warning/10 [&>svg]:text-warning",
      destructive: "border-destructive/30 bg-destructive/10 [&>svg]:text-destructive",
    },
  },
  defaultVariants: { variant: "info" },
});
export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
}
/** Inline message with icon. */
export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(({ className, variant, title, children, ...props }, ref) => {
  const Icon = alertIcons[variant ?? "info"];
  return (
    <div ref={ref} role={variant === "destructive" ? "alert" : "status"} className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon aria-hidden />
      <div className="flex flex-col gap-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
});
Alert.displayName = "Alert";

/* ---------- Progress ---------- */
export const progressVariants = cva("h-full rounded-full transition-all", {
  variants: { tone: { primary: "bg-primary", success: "bg-success", warning: "bg-warning", destructive: "bg-destructive" } },
  defaultVariants: { tone: "primary" },
});
export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof progressVariants> {
  /** 0–100 */
  value: number;
  label: string;
  size?: "sm" | "md";
}
/** Linear progress bar. */
export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(({ className, value, tone, label, size = "md", ...props }, ref) => {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div ref={ref} role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}
      className={cn("w-full overflow-hidden rounded-full bg-muted", size === "sm" ? "h-1.5" : "h-2.5", className)} {...props}>
      <div className={progressVariants({ tone })} style={{ width: `${v}%` }} />
    </div>
  );
});
Progress.displayName = "Progress";

/* ---------- Table ---------- */
export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {}
/** Data table; compose with native thead/tbody/tr. */
export const Table = React.forwardRef<HTMLTableElement, TableProps>(({ className, ...props }, ref) => (
  <div className="w-full overflow-x-auto rounded-lg border">
    <table ref={ref} className={cn("w-full text-sm [&_th]:bg-muted [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-4 [&_td]:py-3 [&_tbody_tr]:border-t [&_tbody_tr:hover]:bg-muted/50", className)} {...props} />
  </div>
));
Table.displayName = "Table";

/* ---------- Tooltip ---------- */
export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  content: string;
  side?: "top" | "bottom";
}
/** CSS tooltip shown on hover and keyboard focus of its child. */
export const Tooltip = React.forwardRef<HTMLSpanElement, TooltipProps>(({ content, side = "top", className, children, ...props }, ref) => (
  <span ref={ref} className={cn("group relative inline-flex", className)} {...props}>
    {children}
    <span role="tooltip" className={cn(
      "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 w-max max-w-64 whitespace-normal rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
      side === "top" ? "bottom-full mb-2" : "top-full mt-2",
    )}>{content}</span>
  </span>
));
Tooltip.displayName = "Tooltip";
