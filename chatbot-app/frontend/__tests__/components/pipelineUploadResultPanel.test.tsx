/**
 * The OMS upload result beside a deal. On a deal of several orders the file is one unit, so a
 * rejection lists errors from every row; each must say which order's row it came from, or the
 * reviewer cannot tell which order to fix.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UploadResultPanel } from "@/components/pipeline/UploadResultPanel";
import type { UploadResult } from "@/lib/pipeline/types";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const rejected = (errors: UploadResult["errors"]): UploadResult => ({
  attempted_at: "2026-10-21T10:00:00Z",
  accepted: false,
  staging_key: null,
  errors,
  validator_version: "2026.09.1",
});

describe("UploadResultPanel", () => {
  it("names the order each error's row belongs to", () => {
    render(
      <UploadResultPanel
        dealId="dl_1"
        orderLabels={["USD 5yr", "EUR 8yr"]}
        upload={rejected([
          { code: "COVENANT_STATUS_REQUIRED", field: "covenant_status_num", message: "m", row: 1 },
          { code: "HEADER_MISMATCH", field: null, message: "h" },
        ])}
      />,
    );
    expect(document.querySelector('[data-row="1"]')).toHaveTextContent("row 2 · EUR 8yr");
    expect(document.querySelectorAll("[data-row]")).toHaveLength(1); // a file-level error has no row
    expect(screen.getByText("HEADER_MISMATCH")).toBeTruthy();
  });
});
