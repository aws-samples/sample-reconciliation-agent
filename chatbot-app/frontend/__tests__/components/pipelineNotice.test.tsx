/**
 * The outcome line every write in the console reports through.
 *
 * It exists so that "Saved" and "Error: …" can never share a colour by accident, so the contract to pin
 * is the mapping from tone to role, attribute and colour — and that a caller's size class replaces the
 * default rather than fighting it.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Notice } from "@/components/pipeline/ui";

describe("Notice", () => {
  it("announces an error, tags it, and draws it red", () => {
    render(<Notice tone="error">Error: config write failed</Notice>);
    const el = screen.getByRole("alert");
    expect(el).toHaveAttribute("data-tone", "error");
    expect(el).toHaveTextContent("Error: config write failed");
    expect(el.style.color).toBe("var(--dp-red)");
  });

  it("reports a success as a status, tagged, in the accent colour", () => {
    render(<Notice tone="success">Saved.</Notice>);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("data-tone", "success");
    expect(el.style.color).toBe("var(--dp-cyan)");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets a caller's classes replace the default size instead of stacking on it", () => {
    render(<Notice tone="success">Saved.</Notice>);
    expect(screen.getByRole("status").className).toBe("dp-mono text-[12px]");
    render(
      <Notice tone="error" className="mt-4 text-[11.5px]">
        no
      </Notice>,
    );
    expect(screen.getByRole("alert").className).toBe("dp-mono mt-4 text-[11.5px]");
  });
});
