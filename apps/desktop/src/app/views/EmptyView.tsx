import type { LucideIcon } from "lucide-react";

export function EmptyView({ title, body, icon: Icon }: { title: string; body: string; icon: LucideIcon }) {
  return (
    <section className="flex flex-1 flex-col gap-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card p-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
          <Icon className="h-7 w-7" />
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
    </section>
  );
}
