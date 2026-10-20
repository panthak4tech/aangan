import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BenchmarkTable,
  MemoryBreakdownBar,
  MetricGauge,
  ModelCard,
  SourceBadge,
  SystemSpecCard,
  formatSourced,
} from "@/components/tax/system";
import {
  ChatMessage,
  ConsentPrompt,
  DocumentDropzone,
  FilingStepGuide,
  QuestionStep,
  ReportPreview,
} from "@/components/tax/workflow";

describe("system design components", () => {
  it("clamps gauges and displays bar and radial values", () => {
    const { rerender } = render(
      <MetricGauge label="CPU usage" value={120} variant="bar" detail="Current load" />,
    );
    expect(screen.getByRole("meter", { name: "CPU usage" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByText("Current load")).toBeInTheDocument();

    rerender(<MetricGauge label="Memory" value={75.5} max={100} unit="GB" size="sm" />);
    expect(screen.getByRole("meter", { name: "Memory" })).toHaveAttribute(
      "aria-valuetext",
      "75.5 GB",
    );
  });

  it("renders hardware specs and distinguishes estimated from measured values", () => {
    const { rerender } = render(
      <SystemSpecCard
        specs={[
          { kind: "cpu", label: "CPU", value: "8 cores", sub: "x86_64" },
          { kind: "gpu", label: "GPU", value: "Integrated" },
          { kind: "ram", label: "RAM", value: "16 GB" },
          { kind: "disk", label: "Disk", value: "512 GB" },
          { kind: "npu", label: "NPU", value: "Available" },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "This computer" })).toBeInTheDocument();
    expect(screen.getByText("x86_64")).toBeInTheDocument();

    rerender(
      <>
        {formatSourced("42 tok/s", "estimated")}
        <SourceBadge source="measured" />
      </>,
    );
    expect(screen.getByText("~42 tok/s")).toBeInTheDocument();
    expect(screen.getByText("Measured")).toBeInTheDocument();
  });

  it("shows model fit, license, speed source, and the fastest benchmark row", () => {
    const { rerender } = render(
      <ModelCard
        name="Local Model"
        params="7B"
        quant="Q4"
        sizeGb={4.7}
        tokensPerSec={22}
        fit="great"
        license="MIT"
        licenseKind="open-source"
        source="measured"
        selected
      />,
    );
    expect(screen.getByText("Runs great")).toBeInTheDocument();
    expect(screen.getByText("Open source")).toBeInTheDocument();
    expect(screen.getByText("22 tok/s")).toBeInTheDocument();

    rerender(
      <ModelCard
        name="Restricted Model"
        params="14B"
        quant="Q4"
        sizeGb={9}
        tokensPerSec={2}
        fit="unsupported"
        license="Custom"
        licenseKind="open-weight"
        source="estimated"
      />,
    );
    expect(screen.getByText("Won't fit")).toBeInTheDocument();
    expect(screen.getByText("~2 tok/s")).toBeInTheDocument();

    rerender(
      <BenchmarkTable
        caption="Fixture benchmark"
        source="estimated"
        rows={[
          { model: "Small", quant: "Q4", tokensPerSec: 12, firstTokenMs: 80, ramGb: 2 },
          { model: "Large", quant: "Q4", tokensPerSec: 18, firstTokenMs: 140, ramGb: 8 },
        ]}
      />,
    );
    expect(screen.getByText("Large")).toBeInTheDocument();
    expect(screen.getByText("Fastest")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Fixture benchmark" })).toBeInTheDocument();
  });

  it("marks memory estimates as fitting or exceeding the available pool", () => {
    const { rerender } = render(
      <MemoryBreakdownBar weightsGb={4} contextGb={1} overheadGb={1} availableGb={8} />,
    );
    expect(screen.getByText("Fits")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Weights 4.0 GB/ })).toBeInTheDocument();

    rerender(
      <MemoryBreakdownBar weightsGb={8} contextGb={2} overheadGb={1} availableGb={8} />,
    );
    expect(screen.getByText("Won't fit")).toBeInTheDocument();
  });
});

describe("workflow design components", () => {
  it("reports question progress and calls back with the selected answer", () => {
    const onChange = vi.fn();
    render(
      <QuestionStep
        question="What do you need?"
        helper="Choose one"
        options={[
          { value: "simple", label: "Simple", hint: "A short answer" },
          { value: "detailed", label: "Detailed" },
        ]}
        value="simple"
        onChange={onChange}
        step={2}
        total={4}
      />,
    );

    expect(screen.getByText("Question 2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Questionnaire progress" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    fireEvent.click(screen.getByRole("radio", { name: /Detailed/ }));
    expect(onChange).toHaveBeenCalledWith("detailed");
  });

  it("accepts uploaded documents and reflects checklist completion", () => {
    const onFiles = vi.fn();
    const { container } = render(
      <DocumentDropzone
        documents={[
          { id: "id", name: "Identity proof", hint: "Upload an ID" },
          { id: "income", name: "Income form", uploaded: "income.pdf" },
        ]}
        onFiles={onFiles}
      />,
    );
    const file = new File(["id"], "identity.pdf", { type: "application/pdf" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    if (!input) throw new Error("document input is missing");
    expect(screen.getByText("1 of 2 added")).toBeInTheDocument();
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(screen.getByText("income.pdf")).toBeInTheDocument();
  });

  it("renders chat roles, pending state, and local or external sources", () => {
    const { rerender } = render(
      <ChatMessage
        role="assistant"
        sources={[
          { title: "Local guide" },
          { title: "External source", href: "https://example.test/source" },
        ]}
      >
        Answer
      </ChatMessage>,
    );
    expect(screen.getByText("Assistant said:")).toBeInTheDocument();
    expect(screen.getByText("Local guide")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /External source/ })).toHaveAttribute(
      "rel",
      "noreferrer",
    );

    rerender(
      <ChatMessage role="user" pending>
        Waiting
      </ChatMessage>,
    );
    expect(screen.getByText("You said:")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("requires an explicit allow or deny action for web search", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(<ConsentPrompt query="local question" onAllow={onAllow} onDeny={onDeny} />);

    expect(screen.getByRole("alertdialog", { name: "Allow web search?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stay offline" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDeny).toHaveBeenCalledOnce();
    expect(onAllow).toHaveBeenCalledOnce();
  });

  it("marks current filing steps and formats report rows for local download", () => {
    const onDownload = vi.fn();
    const { rerender } = render(
      <FilingStepGuide
        steps={[
          { title: "Completed", body: "Done", status: "done" },
          { title: "Current", body: "In progress", status: "current" },
          { title: "Next", body: "Not started", status: "todo" },
        ]}
      />,
    );
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Current").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Next")).toBeInTheDocument();

    rerender(
      <ReportPreview
        title="Tax summary"
        form="ITR-1"
        assessmentYear="2025-26"
        lines={[
          { label: "Income", amount: 120000 },
          { label: "Tax due", amount: 10000, emphasis: true },
        ]}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText("Tax summary")).toBeInTheDocument();
    expect(screen.getByText("Tax due").parentElement).toHaveClass("font-semibold");
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(onDownload).toHaveBeenCalledOnce();
  });
});
