import { FolderOpen, Info, Languages, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { APP_INFO } from "@/api/api";
import { SpecRow } from "@/components/aangan/SystemSpecCard";
import { Badge } from "@/components/primitives/badge";
import { Card } from "@/components/primitives/card";
import { RadioGroup, RadioGroupItem } from "@/components/primitives/radio-group";
import { cn } from "@/lib/utils";
import { en } from "@/i18n/en";

function SettingsSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 p-5 shadow-none">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="h-5 w-5" />
        </span>
        <h2 className="font-display text-base font-semibold text-card-foreground">{title}</h2>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </Card>
  );
}

export function SettingsView() {
  const t = en.views.settings;
  const [lang, setLang] = useState<string>(APP_INFO.languages[0].code);

  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <SettingsSection icon={ShieldCheck} title={t.privacy.title}>
        <p className="text-sm text-muted-foreground">{t.privacy.body}</p>
      </SettingsSection>

      <SettingsSection icon={FolderOpen} title={t.data.title}>
        <p className="text-sm text-muted-foreground">{t.data.body}</p>
        <code className="select-all break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {APP_INFO.data_dir}
        </code>
        <p className="text-xs text-muted-foreground">{t.data.hint}</p>
      </SettingsSection>

      <SettingsSection icon={Languages} title={t.language.title}>
        <RadioGroup value={lang} onValueChange={setLang} className="gap-3">
          {APP_INFO.languages.map((l) => (
            <label
              key={l.code}
              className={cn("flex items-center gap-3 text-sm", !l.available && "cursor-not-allowed")}
            >
              <RadioGroupItem value={l.code} disabled={!l.available} />
              <span className={l.available ? "text-foreground" : "text-muted-foreground"}>
                {t.language.options[l.code]}
              </span>
              {!l.available && <Badge variant="unknown">{t.language.comingSoon}</Badge>}
            </label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection icon={Info} title={t.about.title}>
        <dl className="flex flex-col gap-2.5">
          <SpecRow label={t.about.version} value={APP_INFO.version} />
          <SpecRow label={t.about.license} value={APP_INFO.license} />
        </dl>
        {/* Text only: the app is offline, so nothing opens when this is read. */}
        <span className="w-fit select-all text-sm font-medium text-primary underline underline-offset-4">
          {t.about.notices}
        </span>
      </SettingsSection>
    </section>
  );
}
