import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  body,
  tips,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  tips?: readonly string[];
}) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-2xl border border-dashed border-border bg-card p-6 sm:flex-row">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex flex-col gap-2">
        <p className="font-display text-lg font-semibold text-card-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
        {tips && (
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm text-card-foreground">
            {tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
