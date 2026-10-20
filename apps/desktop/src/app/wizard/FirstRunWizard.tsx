import { Check, ShieldCheck, WifiOff, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { scanHardware } from "@/api/api";
import type { HardwareProfile } from "@/api/types";
import { ErrorState } from "@/components/aangan/ErrorState";
import { Stepper, type StepStatus } from "@/components/aangan/Stepper";
import { WizardShell } from "@/components/aangan/WizardShell";
import { Button } from "@/components/primitives/button";
import { Checkbox } from "@/components/primitives/checkbox";
import { en } from "@/i18n/en";
import { buildDiagnostics, summarizeProfile } from "./summary";

type Phase =
  | { kind: "welcome" }
  | { kind: "scanning" }
  | { kind: "error"; error: unknown }
  | { kind: "done"; profile: HardwareProfile };

const PARTS = ["cpu", "memory", "gpu", "storage"] as const;
const STEP_MS = 450;

export function FirstRunWizard({ onComplete }: { onComplete: (p: HardwareProfile, measured: boolean) => void }) {
  const t = en.wizard;
  const [phase, setPhase] = useState<Phase>({ kind: "welcome" });
  const [measure, setMeasure] = useState(true);
  const [progress, setProgress] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const runId = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  const startScan = async () => {
    const id = ++runId.current;
    setProgress(0);
    setCopied(false);
    setPhase({ kind: "scanning" });
    stopTimer();
    // Visual progress; the last part only completes when the scan resolves.
    timer.current = setInterval(
      () => setProgress((p) => Math.min(p + 1, PARTS.length - 1)),
      measure ? STEP_MS * 1.8 : STEP_MS,
    );
    try {
      const profile = await scanHardware(measure);
      if (id !== runId.current) return;
      stopTimer();
      setProgress(PARTS.length);
      setTimeout(() => id === runId.current && setPhase({ kind: "done", profile }), 400);
    } catch (error) {
      if (id !== runId.current) return;
      stopTimer();
      setPhase({ kind: "error", error });
    }
  };

  const cancel = () => {
    runId.current++;
    stopTimer();
    setPhase({ kind: "welcome" });
  };

  const copyDiagnostics = async (error: unknown) => {
    try {
      await navigator.clipboard.writeText(buildDiagnostics(error, measure));
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const stepLabel = (i: number) => t.stepOf(i + 1, 3);

  if (phase.kind === "welcome") {
    const points = [
      { icon: WifiOff, text: t.welcome.offline },
      { icon: ShieldCheck, text: t.welcome.private },
      { icon: Download, text: t.welcome.choose },
    ];
    return (
      <WizardShell
        stepIndex={0}
        stepCount={3}
        stepLabel={stepLabel(0)}
        title={t.welcome.title}
        description={t.welcome.body}
        footer={
          <Button size="lg" onClick={startScan}>
            {t.welcome.cta}
          </Button>
        }
      >
        <ul className="flex flex-col gap-3">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-sm text-foreground">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
                <Icon className="h-4 w-4" />
              </span>
              {text}
            </li>
          ))}
        </ul>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-muted p-4 text-sm">
          <Checkbox
            checked={measure}
            onCheckedChange={(v) => setMeasure(v === true)}
            className="mt-0.5"
          />
          <span className="text-foreground">{t.welcome.measure}</span>
        </label>
      </WizardShell>
    );
  }

  if (phase.kind === "scanning" || phase.kind === "error") {
    const items = PARTS.map((id, i) => ({
      id,
      label: t.scanning.parts[id],
      status: (i < progress ? "done" : i === progress ? "active" : "pending") as StepStatus,
    }));
    return (
      <WizardShell
        stepIndex={1}
        stepCount={3}
        stepLabel={stepLabel(1)}
        title={phase.kind === "error" ? t.error.heading : t.scanning.title}
        description={phase.kind === "error" ? undefined : t.scanning.body}
        footer={
          phase.kind === "scanning" ? (
            <Button variant="outline" onClick={cancel}>
              {t.scanning.cancel}
            </Button>
          ) : undefined
        }
      >
        {phase.kind === "scanning" ? (
          <Stepper items={items} />
        ) : (
          <ErrorState
            title={t.error.title}
            body={t.error.body}
            actions={
              <>
                <Button onClick={startScan}>{t.error.retry}</Button>
                <Button variant="outline" onClick={() => copyDiagnostics(phase.error)}>
                  {copied && <Check className="h-4 w-4" />}
                  {copied ? t.error.copied : t.error.copy}
                </Button>
              </>
            }
            footer={copyFailed ? <p className="text-xs text-destructive">{t.error.copyFailed}</p> : undefined}
          />
        )}
      </WizardShell>
    );
  }

  return (
    <WizardShell
      stepIndex={2}
      stepCount={3}
      stepLabel={stepLabel(2)}
      title={t.done.title}
      footer={
        <Button size="lg" onClick={() => onComplete(phase.profile, measure)}>
          {t.done.cta}
        </Button>
      }
    >
      <div className="flex items-center gap-3 rounded-xl bg-primary-soft p-4 text-primary-soft-foreground">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fit-great text-fit-great-fg">
          <Check className="h-4 w-4" />
        </span>
        <p className="text-sm font-medium">{summarizeProfile(phase.profile)}</p>
      </div>
    </WizardShell>
  );
}
