import { Cpu, LayoutGrid, Settings } from "lucide-react";
import mark from "@/assets/brand/aangan-mark.png";
import { cn } from "@/lib/utils";
import { en } from "@/i18n/en";

export type View = "scan" | "models" | "settings";

const ITEMS: { id: View; icon: typeof Cpu }[] = [
  { id: "scan", icon: Cpu },
  { id: "models", icon: LayoutGrid },
  { id: "settings", icon: Settings },
];

export function NavRail({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav
      aria-label={en.nav.label}
      className="flex w-24 shrink-0 flex-col items-center gap-2 border-r border-sidebar-border bg-sidebar py-5"
    >
      <img src={mark} alt={en.app.name} width={40} height={40} className="mb-6 h-10 w-10 rounded-xl" />
      {ITEMS.map(({ id, icon: Icon }) => {
        const active = view === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex w-20 flex-col items-center gap-1 rounded-xl px-2 py-3 text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Icon className={cn("h-5 w-5", active && "text-sidebar-primary")} />
            {en.nav[id]}
          </button>
        );
      })}
    </nav>
  );
}
