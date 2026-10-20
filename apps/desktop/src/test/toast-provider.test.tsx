import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "@/components/ui/toast-provider";

function ToastTrigger() {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => toast("Saved report", {
        variant: "success",
        action: { label: "Show in folder", onClick: () => {} },
      })}
    >
      Show toast
    </button>
  );
}

afterEach(() => vi.useRealTimers());

describe("ToastProvider", () => {
  it("renders an accessible toast and runs its action", () => {
    const onAction = vi.fn();
    function Trigger() {
      const toast = useToast();
      return <button onClick={() => toast("Saved report", {
        variant: "success",
        action: { label: "Show in folder", onClick: onAction },
      })}>Show toast</button>;
    }
    render(<ToastProvider><Trigger /></ToastProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("automatically dismisses success notifications after six seconds", () => {
    vi.useFakeTimers();
    render(<ToastProvider><ToastTrigger /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps error notifications visible until dismissed", () => {
    function ErrorTrigger() {
      const toast = useToast();
      return <button onClick={() => toast("Save failed", { variant: "destructive" })}>Show error</button>;
    }
    vi.useFakeTimers();
    render(<ToastProvider><ErrorTrigger /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Show error" }));

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
