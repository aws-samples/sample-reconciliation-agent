/**
 * The assistant conversation panel.
 *
 * Two things a viewer must be able to trust. The transcript never loses a turn: the input stays closed
 * until the history fetch has landed, because that fetch replaces the transcript and would take a turn
 * sent into the gap — and the reply streaming into it — with it. And a refused write looks refused:
 * when the BFF turns down save_memory or delete_memory for a caller outside the admin group, the tool
 * chip and its reason are drawn in the error colour, never as the tick a reader would take for "saved".
 *
 * And the session id is unguessable however it was minted. CodeQL flagged the old `Math.random()`
 * fallback (`js/insecure-randomness`, alert 9); the branch it guarded runs wherever
 * `crypto.randomUUID` is unavailable, which is precisely where predictable ids would matter.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatStreamEvent } from "@/lib/pipeline/types";

const getChatHistory = vi.fn();
const streamChat = vi.fn();
vi.mock("@/lib/pipelineApi", () => ({
  getChatHistory: (...a: unknown[]) => getChatHistory(...a),
  streamChat: (...a: unknown[]) => streamChat(...a),
}));

import { ChatPanel } from "@/components/pipeline/ChatPanel";

type OnEvent = (event: ChatStreamEvent) => void;

/** A promise the test settles by hand, to hold the history fetch open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The wording the BFF uses when it refuses a write for a caller outside the admin group. */
const REFUSAL = "save_memory requires the admin group; nothing was written";

const EARLIER: ChatMessage[] = [
  { role: "user", content: "earlier question", at: "2026-08-05T13:00:00Z" },
  { role: "assistant", content: "earlier answer", at: "2026-08-05T13:00:05Z" },
];

beforeEach(() => {
  getChatHistory.mockReset();
  streamChat.mockReset();
});

describe("ChatPanel", () => {
  it("keeps the input closed until the history has loaded, then sends without losing a turn", async () => {
    const history = deferred<ChatMessage[]>();
    getChatHistory.mockReturnValue(history.promise);
    streamChat.mockImplementation(async (_body: unknown, onEvent: OnEvent) => {
      onEvent({ type: "text", delta: "Two deals failed." });
      onEvent({ type: "done", session_id: "s" });
    });
    render(<ChatPanel />);

    const input = await screen.findByRole("textbox", { name: "Message" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "loading the conversation…");
    // Neither Enter nor a form submit may start a turn while the gap is open. The change event still
    // lands (React does not gate it on `disabled`), which is what exercises the guard inside `send`.
    fireEvent.change(input, { target: { value: "Which deals failed?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.submit(input.closest("form")!);
    expect(streamChat).not.toHaveBeenCalled();

    await act(async () => {
      history.resolve(EARLIER);
    });
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("placeholder", "Message the assistant…");
    expect(screen.getByText("earlier answer")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    expect(streamChat.mock.calls[0][0]).toMatchObject({
      message: "Which deals failed?",
    });
    expect(await screen.findByText("Two deals failed.")).toBeTruthy();
    // The new turn and the loaded history are both on screen: nothing overwrote anything.
    expect(screen.getByText("Which deals failed?")).toBeTruthy();
    expect(screen.getByText("earlier answer")).toBeTruthy();
  });

  it("draws a tool result refused for lack of the admin group in the error style, with its reason", async () => {
    getChatHistory.mockResolvedValue([
      {
        role: "user",
        content: "Save that as a rule.",
        at: "2026-08-05T13:01:00Z",
      },
      {
        role: "assistant",
        content: "I could not save it.",
        at: "2026-08-05T13:01:04Z",
        tools: [
          { name: "get_deal", ok: true, summary: "dl_1 STAGED" },
          // The flag says ok — the BFF answered — but the write was refused.
          { name: "save_memory", ok: true, summary: REFUSAL },
        ],
      },
    ]);
    render(<ChatPanel />);

    const refused = await screen.findByText(/✕ save_memory/);
    expect(refused).toHaveAttribute("data-tool-state", "failed");
    expect(refused.style.color).toContain("--rc-red");
    const fine = screen.getByText(/✓ get_deal/);
    expect(fine).toHaveAttribute("data-tool-state", "ok");
    expect(fine.style.color).toContain("--rc-cyan");
    // The reason is written out under the chips, not left in a hover-only tooltip.
    const reason = screen.getByRole("alert");
    expect(reason).toHaveTextContent(REFUSAL);
    expect(reason.style.color).toContain("--rc-red");
  });

  it("shows a refusal streamed mid-turn as a failure, not a completed write", async () => {
    getChatHistory.mockResolvedValue([]);
    streamChat.mockImplementation(async (_body: unknown, onEvent: OnEvent) => {
      onEvent({ type: "tool_call", name: "save_memory", input: {} });
      onEvent({
        type: "tool_result",
        name: "save_memory",
        ok: false,
        summary: REFUSAL,
      });
      onEvent({ type: "text", delta: "I was not allowed to save that." });
      onEvent({ type: "done", session_id: "s" });
    });
    render(<ChatPanel />);

    const input = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "Save it." } });
    fireEvent.keyDown(input, { key: "Enter" });

    const chip = await screen.findByText(/✕ save_memory/);
    expect(chip).toHaveAttribute("data-tool-state", "failed");
    expect(screen.getByRole("alert")).toHaveTextContent(REFUSAL);
    expect(document.querySelector('[data-tool-state="ok"]')).toBeNull();
    expect(
      await screen.findByText("I was not allowed to save that."),
    ).toBeTruthy();
  });

  // Both branches of newSessionId(). The fallback is the one CodeQL flagged, and it is unreachable in
  // a jsdom that provides randomUUID — so the test removes randomUUID to force it, and asserts the
  // id both satisfies the server's SESSION_ID pattern and came from the CSPRNG rather than the clock.
  it.each([
    ["randomUUID is available", true],
    ["randomUUID is missing, the branch CodeQL flagged", false],
  ])(
    "mints a session id from the CSPRNG when %s",
    async (_label, hasRandomUuid) => {
      const realUuid = crypto.randomUUID;
      const getRandomValues = vi.spyOn(crypto, "getRandomValues");
      if (!hasRandomUuid) {
        // Defined on the prototype in jsdom, so `delete` on the instance is a no-op; shadow it.
        Object.defineProperty(crypto, "randomUUID", {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }
      window.sessionStorage.clear();
      getChatHistory.mockResolvedValue([]);
      try {
        render(<ChatPanel />);
        await waitFor(() => expect(getChatHistory).toHaveBeenCalled());

        const sessionId = String(getChatHistory.mock.calls[0][0]);
        // The character set the memory API accepts, mirrored by SESSION_ID in the BFF.
        expect(sessionId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
        // No timestamp: Date.now() in base36 is the prefix the weak fallback used to carry.
        expect(sessionId).not.toContain(Date.now().toString(36).slice(0, 6));
        if (!hasRandomUuid) {
          expect(getRandomValues).toHaveBeenCalled();
          expect(sessionId).toMatch(/^s-[0-9a-f]{32}$/);
        }
      } finally {
        Object.defineProperty(crypto, "randomUUID", {
          value: realUuid,
          configurable: true,
          writable: true,
        });
        getRandomValues.mockRestore();
      }
    },
  );
});
