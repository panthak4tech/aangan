import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const fieldBase =
  "w-full rounded-md border bg-card text-foreground placeholder:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const inputVariants = cva(fieldBase, {
  variants: {
    size: { sm: "h-8 px-2.5 text-sm", md: "h-10 px-3 text-sm", lg: "h-12 px-4 text-base" },
    state: { default: "border-input", error: "border-destructive focus-visible:ring-destructive" },
  },
  defaultVariants: { size: "md", state: "default" },
});

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

/** Single-line text field. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, state, ...props }, ref) => (
    <input ref={ref} aria-invalid={state === "error" || undefined} className={cn(inputVariants({ size, state }), className)} {...props} />
  ),
);
Input.displayName = "Input";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    Pick<VariantProps<typeof inputVariants>, "state"> {}

/** Multi-line text field. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, state, ...props }, ref) => (
    <textarea ref={ref} aria-invalid={state === "error" || undefined} className={cn(inputVariants({ state }), "min-h-24 px-3 py-2 text-sm", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size">,
    VariantProps<typeof inputVariants> {}

/** Native select with system styling. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, size, state, children, ...props }, ref) => (
    <div className="relative">
      <select ref={ref} className={cn(inputVariants({ size, state }), "appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </div>
  ),
);
Select.displayName = "Select";

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {}

/** Form label; always pair with htmlFor. */
export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn("text-sm font-medium leading-none", className)} {...props} />
));
Label.displayName = "Label";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
}

/** Label + control + hint/error stack. */
export const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  ({ label, htmlFor, hint, error, className, children, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col gap-1.5", className)} {...props}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  ),
);
Field.displayName = "Field";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: React.ReactNode;
}

/** Checkbox with optional inline label. */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(({ className, label, id, ...props }, ref) => (
  <label htmlFor={id} className={cn("inline-flex items-center gap-2 text-sm has-[:disabled]:opacity-50", className)}>
    <input ref={ref} id={id} type="checkbox" className="size-4 rounded-sm border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" {...props} />
    {label}
  </label>
));
Checkbox.displayName = "Checkbox";

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: React.ReactNode;
}

/** Radio button with optional inline label. */
export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(({ className, label, id, ...props }, ref) => (
  <label htmlFor={id} className={cn("inline-flex items-center gap-2 text-sm has-[:disabled]:opacity-50", className)}>
    <input ref={ref} id={id} type="radio" className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" {...props} />
    {label}
  </label>
));
Radio.displayName = "Radio";
