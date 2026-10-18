import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/primitives/card";

export function SystemSpecCard({
  icon: Icon,
  title,
  subtitle,
  badges,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string | undefined;
  badges?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4 p-5 shadow-none">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {subtitle && (
            <span className="truncate font-display text-base font-semibold text-card-foreground">
              {subtitle}
            </span>
          )}
        </div>
        {badges && <div className="flex shrink-0 flex-wrap gap-1.5">{badges}</div>}
      </div>
      {children && <dl className="flex flex-col gap-2.5">{children}</dl>}
    </Card>
  );
}

export function SpecRow({ label, value, badge }: { label: string; value: ReactNode; badge?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-right font-medium tabular-nums text-card-foreground">
        {value}
        {badge}
      </dd>
    </div>
  );
}
