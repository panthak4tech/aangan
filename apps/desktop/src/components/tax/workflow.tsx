import * as React from "react";
import { Bot, Check, CircleDashed, ExternalLink, FileText, Globe, Upload, User, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/display";
import { Progress } from "@/components/ui/display";

/* ---------- QuestionStep ---------- */
export interface QuestionOption { value: string; label: string; hint?: string }
export interface QuestionStepProps extends Omit<React.HTMLAttributes<HTMLFieldSetElement>, "onChange"> {
  question: string;
  helper?: string;
  options: QuestionOption[];
  value?: string;
  onChange: (value: string) => void;
  step: number;
  total: number;
}
/** One question of the form-finder wizard, rendered as selectable cards. */
export const QuestionStep = React.forwardRef<HTMLFieldSetElement, QuestionStepProps>(
  ({ question, helper, options, value, onChange, step, total, className, ...props }, ref) => {
    const name = React.useId();
    return (
      <fieldset ref={ref} className={cn("flex flex-col gap-4", className)} {...props}>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Question {step} of {total}</p>
          <Progress value={(step / total) * 100} label="Questionnaire progress" size="sm" />
        </div>
        <legend className="sr-only">{question}</legend>
        <div aria-hidden>
          <p className="font-display text-xl font-semibold">{question}</p>
          {helper && <p className="mt-1 text-sm text-muted-foreground">{helper}</p>}
        </div>
        <div className="grid gap-2">
          {options.map((o) => {
            const on = value === o.value;
            return (
              <label key={o.value} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                on ? "border-primary bg-primary/5" : "hover:bg-muted")}>
                <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="mt-0.5 size-4 accent-primary focus:outline-none" />
                <span><span className="block text-sm font-medium">{o.label}</span>{o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  },
);
QuestionStep.displayName = "QuestionStep";

/* ---------- DocumentDropzone ---------- */
export interface RequiredDoc { id: string; name: string; hint?: string; uploaded?: string }
export interface DocumentDropzoneProps extends React.HTMLAttributes<HTMLDivElement> {
  documents: RequiredDoc[];
  onFiles: (files: File[]) => void;
  accept?: string;
}
/** Drop area plus checklist of documents required for the chosen ITR form. */
export const DocumentDropzone = React.forwardRef<HTMLDivElement, DocumentDropzoneProps>(
  ({ documents, onFiles, accept = ".pdf,.jpg,.png,.xlsx,.csv", className, ...props }, ref) => {
    const [drag, setDrag] = React.useState(false);
    const inputId = React.useId();
    const done = documents.filter((d) => d.uploaded).length;
    return (
      <div ref={ref} className={cn("flex flex-col gap-4", className)} {...props}>
        <label htmlFor={inputId}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files)); }}
          className={cn("flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            drag ? "border-primary bg-primary/5" : "border-input hover:bg-muted")}>
          <Upload className="size-6 text-primary" aria-hidden />
          <span className="text-sm font-medium">Drop documents here or click to browse</span>
          <span className="text-xs text-muted-foreground">PDF, images or spreadsheets. Files never leave this computer.</span>
          <input id={inputId} type="file" multiple accept={accept} className="sr-only" onChange={(e) => onFiles(Array.from(e.target.files ?? []))} />
        </label>
        <div className="flex items-center justify-between text-sm"><span className="font-medium">Checklist</span><span className="text-muted-foreground">{done} of {documents.length} added</span></div>
        <ul className="flex flex-col gap-2">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-lg border p-3">
              {d.uploaded ? <Check className="size-4 text-success" aria-label="Added" /> : <CircleDashed className="size-4 text-muted-foreground" aria-label="Missing" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{d.name}</p>
                <p className="truncate text-xs text-muted-foreground">{d.uploaded ?? d.hint}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  },
);
DocumentDropzone.displayName = "DocumentDropzone";

/* ---------- ChatMessage ---------- */
export interface ChatSource { title: string; href?: string }
export interface ChatMessageProps extends React.HTMLAttributes<HTMLDivElement> {
  role: "user" | "assistant";
  sources?: ChatSource[];
  pending?: boolean;
}
/** A chat bubble; assistant messages may cite local docs or web sources. */
export const ChatMessage = React.forwardRef<HTMLDivElement, ChatMessageProps>(({ role, sources, pending, className, children, ...props }, ref) => {
  const isUser = role === "user";
  return (
    <div ref={ref} className={cn("flex gap-3", isUser && "flex-row-reverse", className)} {...props}>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", isUser ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground")} aria-hidden>
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </span>
      <div className={cn("flex max-w-[80%] flex-col gap-2 rounded-2xl px-4 py-3 text-sm", isUser ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-muted")}>
        <span className="sr-only">{isUser ? "You said:" : "Assistant said:"}</span>
        {pending ? <span className="flex gap-1" aria-label="Thinking"><span className="size-1.5 animate-bounce rounded-full bg-current" /><span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" /><span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" /></span> : children}
        {sources && sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {sources.map((s) => s.href ? (
              <a key={s.title} href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Globe className="size-3" aria-hidden />{s.title}<ExternalLink className="size-3" aria-hidden /></a>
            ) : (
              <span key={s.title} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs"><FileText className="size-3" aria-hidden />{s.title}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
ChatMessage.displayName = "ChatMessage";

/* ---------- ConsentPrompt ---------- */
export interface ConsentPromptProps extends React.HTMLAttributes<HTMLDivElement> {
  query: string;
  onAllow: () => void;
  onDeny: () => void;
}
/** Asks permission before any online web search. */
export const ConsentPrompt = React.forwardRef<HTMLDivElement, ConsentPromptProps>(({ query, onAllow, onDeny, className, ...props }, ref) => (
  <Card ref={ref} padding="sm" role="alertdialog" aria-label="Allow web search?" className={cn("flex flex-col gap-3 border-warning/50 bg-warning/5", className)} {...props}>
    <div className="flex items-start gap-3">
      <Globe className="mt-0.5 size-5 text-warning" aria-hidden />
      <div className="text-sm">
        <p className="font-medium">Search the web for this?</p>
        <p className="text-muted-foreground">Only this search phrase is sent online. Your documents stay on this computer.</p>
        <p className="mt-2 rounded-md bg-card px-2 py-1 font-mono text-xs">{query}</p>
      </div>
    </div>
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={onDeny}>Stay offline</Button>
      <Button size="sm" onClick={onAllow}>Allow once</Button>
    </div>
  </Card>
));
ConsentPrompt.displayName = "ConsentPrompt";

/* ---------- FilingStepGuide ---------- */
export interface FilingStep { title: string; body: React.ReactNode; status: "done" | "current" | "todo" }
export interface FilingStepGuideProps extends React.HTMLAttributes<HTMLOListElement> {
  steps: FilingStep[];
}
/** Vertical, numbered walkthrough of the e-filing portal. */
export const FilingStepGuide = React.forwardRef<HTMLOListElement, FilingStepGuideProps>(({ steps, className, ...props }, ref) => (
  <ol ref={ref} className={cn("flex flex-col", className)} {...props}>
    {steps.map((s, i) => (
      <li key={s.title} aria-current={s.status === "current" ? "step" : undefined} className="relative flex gap-4 pb-6 last:pb-0">
        {i < steps.length - 1 && <span className={cn("absolute left-3.5 top-8 h-[calc(100%-2rem)] w-px", s.status === "done" ? "bg-primary" : "bg-border")} aria-hidden />}
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          s.status === "done" && "bg-primary text-primary-foreground",
          s.status === "current" && "border-2 border-primary bg-card text-primary",
          s.status === "todo" && "bg-muted text-muted-foreground")}>
          {s.status === "done" ? <Check className="size-3.5" aria-hidden /> : i + 1}
        </span>
        <div className={cn("flex-1 pt-0.5", s.status === "todo" && "text-muted-foreground")}>
          <p className="text-sm font-semibold">{s.title}</p>
          <div className="mt-1 text-sm text-muted-foreground">{s.body}</div>
        </div>
      </li>
    ))}
  </ol>
));
FilingStepGuide.displayName = "FilingStepGuide";

/* ---------- ReportPreview ---------- */
export interface ReportLine { label: string; amount: number; emphasis?: boolean }
export interface ReportPreviewProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  form: string;
  assessmentYear: string;
  lines: ReportLine[];
  onDownload?: () => void;
}
const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
/** Paper-style summary of the computed return, with PDF download. */
export const ReportPreview = React.forwardRef<HTMLDivElement, ReportPreviewProps>(({ title, form, assessmentYear, lines, onDownload, className, ...props }, ref) => (
  <Card ref={ref} variant="elevated" className={cn("flex flex-col gap-4", className)} {...props}>
    <div className="flex items-start justify-between gap-4 border-b pb-4">
      <div>
        <p className="font-display text-lg font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">Assessment year {assessmentYear}</p>
      </div>
      <Badge variant="primary">{form}</Badge>
    </div>
    <dl className="flex flex-col gap-2 text-sm">
      {lines.map((l) => (
        <div key={l.label} className={cn("flex justify-between gap-4", l.emphasis && "border-t pt-2 font-semibold")}>
          <dt className={l.emphasis ? "" : "text-muted-foreground"}>{l.label}</dt>
          <dd className="font-mono">{inr(l.amount)}</dd>
        </div>
      ))}
    </dl>
    <p className="text-xs text-muted-foreground">This summary is a guide only and is not a substitute for advice from a Chartered Accountant.</p>
    {onDownload && <Button variant="outline" onClick={onDownload}><Download aria-hidden />Download PDF</Button>}
  </Card>
));
ReportPreview.displayName = "ReportPreview";
