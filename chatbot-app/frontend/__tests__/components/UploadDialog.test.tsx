/**
 * Render tests for the upload dialog.
 *
 * What these pin down is the derivation. The operator picks a workflow type and nothing else about
 * the destination, so the assertions are about the form body the dialog builds from that one choice:
 * an extraction type must carry its pinned configuration version and no document type, and a
 * knowledge-base type must carry the document type and no version. Getting either backwards uploads
 * a file to the right bucket with metadata that makes it unreachable, which nothing downstream
 * reports as an error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// `vi.hoisted`, not three plain consts: `vi.mock` is hoisted above every import in the file, so a
// factory that closes over ordinary top-level variables reads them before they are initialised and
// the whole suite fails to collect with "Cannot access 'uploadFiles' before initialization".
const { uploadFiles, listWorkflowTypes, listSkills } = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
  listWorkflowTypes: vi.fn(),
  listSkills: vi.fn(),
}));

vi.mock("@/lib/reconApi", () => ({
  uploadFiles,
  listWorkflowTypes,
  listSkills,
}));

import { UploadDialog } from "@/components/recon/UploadDialog";

const EXTRACTION = {
  workflow_type_id: "wt-notice",
  display_name: "Counterparty notice",
  route: "extraction" as const,
  idp_config_version: "Recon-IDP",
  kb_doc_type: "",
  active: true,
};

const KB = {
  workflow_type_id: "wt-guidance",
  display_name: "Desk guidance",
  route: "knowledge-base" as const,
  idp_config_version: "",
  kb_doc_type: "email",
  active: true,
};

const RETIRED = { ...EXTRACTION, workflow_type_id: "wt-old", active: false };

/** A file the policy accepts, so a test about routing does not fail on validation. */
function pdf(name = "notice.pdf"): File {
  return new File(["x"], name, { type: "application/pdf" });
}

describe("UploadDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorkflowTypes.mockResolvedValue([EXTRACTION, KB, RETIRED]);
    listSkills.mockResolvedValue([{ name: "consult-guidance" }]);
    uploadFiles.mockResolvedValue({
      submissionId: "s1",
      files: [
        {
          filename: "notice.pdf",
          object_key: "k",
          status: "UPLOADED",
          size_bytes: 1,
        },
      ],
    });
  });

  it("does not offer a retired workflow type", async () => {
    render(<UploadDialog onClose={vi.fn()} onUploaded={vi.fn()} />);
    await screen.findByText("Counterparty notice (extraction)");
    // Retired types stay visible on the Config tab. Offering one here would upload against a
    // configuration somebody deliberately took out of service.
    expect(screen.queryByText(/wt-old/)).toBeNull();
  });

  it("sends the pinned configuration version and no document type on an extraction route", async () => {
    render(<UploadDialog onClose={vi.fn()} onUploaded={vi.fn()} />);
    const select = await screen.findByLabelText("Workflow type");
    fireEvent.change(select, { target: { value: "wt-notice" } });
    fireEvent.change(screen.getByLabelText("Files"), {
      target: { files: [pdf()] },
    });
    fireEvent.click(screen.getByText("Upload"));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalled());
    const form = uploadFiles.mock.calls[0][0] as FormData;
    expect(form.get("route")).toBe("extraction");
    expect(form.get("configVersion")).toBe("Recon-IDP");
    expect(form.get("docType")).toBe("");
  });

  it("sends the document type and no configuration version on a knowledge-base route", async () => {
    render(<UploadDialog onClose={vi.fn()} onUploaded={vi.fn()} />);
    const select = await screen.findByLabelText("Workflow type");
    fireEvent.change(select, { target: { value: "wt-guidance" } });
    fireEvent.change(screen.getByLabelText("Files"), {
      target: { files: [pdf()] },
    });
    fireEvent.click(screen.getByText("Upload"));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalled());
    const form = uploadFiles.mock.calls[0][0] as FormData;
    expect(form.get("route")).toBe("knowledge-base");
    expect(form.get("docType")).toBe("email");
    expect(form.get("configVersion")).toBe("");
  });

  it("refuses a file the policy rejects without calling the route", async () => {
    render(<UploadDialog onClose={vi.fn()} onUploaded={vi.fn()} />);
    const select = await screen.findByLabelText("Workflow type");
    fireEvent.change(select, { target: { value: "wt-notice" } });
    fireEvent.change(screen.getByLabelText("Files"), {
      target: { files: [new File(["x"], "sheet.xlsx")] },
    });

    expect(screen.getByText(/not an accepted type/)).toBeTruthy();
    fireEvent.click(screen.getByText("Upload"));
    // Disabled, so the click does nothing. Asserting the absence of the call rather than the
    // disabled attribute: what matters is that no request went out, not how it was prevented.
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("keeps a failed file's reason on screen instead of closing", async () => {
    uploadFiles.mockResolvedValue({
      submissionId: "s1",
      files: [
        {
          filename: "a.pdf",
          object_key: "k",
          status: "UPLOADED",
          size_bytes: 1,
        },
        {
          filename: "b.pdf",
          object_key: "",
          status: "FAILED",
          size_bytes: 1,
          error: "the file is empty — nothing was read from it",
        },
      ],
    });
    const onClose = vi.fn();
    render(<UploadDialog onClose={onClose} onUploaded={vi.fn()} />);
    const select = await screen.findByLabelText("Workflow type");
    fireEvent.change(select, { target: { value: "wt-notice" } });
    fireEvent.change(screen.getByLabelText("Files"), {
      target: { files: [pdf("a.pdf"), pdf("b.pdf")] },
    });
    fireEvent.click(screen.getByText("Upload"));

    // One succeeded and one did not. Closing on the way out would leave the operator believing
    // both landed, with the difference recorded only in the audit table.
    expect(await screen.findByText(/b\.pdf — FAILED/)).toBeTruthy();
    expect(screen.getByText(/nothing was read from it/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
