import { useMemo, useState } from "react";
import notices from "@/assets/third-party-notices.json";
import { Badge } from "@/components/primitives/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog";
import { Input } from "@/components/primitives/input";
import { en } from "@/i18n/en";
import {
  filterNotices,
  mergeNotices,
  sortNotices,
} from "../../../../../scripts/notices-data.mjs";

const sortedNotices = sortNotices(mergeNotices(notices));
const aanganLicense = sortedNotices.find((notice) => notice.name === "Aangan");
const thirdPartyNotices = sortedNotices.filter((notice) => notice.name !== "Aangan");

export function NoticesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleNotices = useMemo(() => filterNotices(thirdPartyNotices, query), [query]);
  const t = en.views.settings.about;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t.noticesTitle}</DialogTitle>
          <DialogDescription>{t.noticesDescription}</DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          aria-label={t.noticesSearch}
          placeholder={t.noticesSearch}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {aanganLicense && (
            <section className="rounded-lg border border-border p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{aanganLicense.name}</h3>
                <Badge variant="secondary">{aanganLicense.version}</Badge>
                <Badge variant="outline">{aanganLicense.license}</Badge>
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                {aanganLicense.text}
              </pre>
            </section>
          )}
          {visibleNotices.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t.noticesEmpty}</p>
          ) : (
            <ul className="space-y-3">
              {visibleNotices.map((notice) => (
                <li key={`${notice.name}@${notice.version}`} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{notice.name}</h3>
                    <Badge variant="secondary">{notice.version}</Badge>
                    <Badge variant="outline">{notice.license}</Badge>
                  </div>
                  <details className="mt-3">
                    <summary className="w-fit cursor-pointer text-sm font-medium text-primary">
                      {t.showLicense}
                    </summary>
                    <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                      {notice.text}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
