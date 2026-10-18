import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepStatus = "pending" | "active" | "done";

export function Stepper({ items }: { items: { id: string; label: string; status: StepStatus }[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((it) => (
        <li
          key={it.id}
          className={cn(
            "flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm transition-colors",
            it.status === "pending" && "text-muted-foreground",
            it.status === "active" && "border-primary bg-accent text-accent-foreground",
            it.status === "done" && "text-foreground",
          )}
        >
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border border-border",
              it.status === "done" && "border-transparent bg-fit-great text-fit-foreground",
            )}
          >
            {it.status === "done" && <Check className="h-3.5 w-3.5" />}
            {it.status === "active" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
          </span>
          <span className="font-medium">{it.label}</span>
        </li>
      ))}
    </ol>
  );
}
