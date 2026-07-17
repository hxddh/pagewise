import { describe, expect, it, vi } from "vitest";
import { sendWithImageFallback } from "./agent-send";

describe("sendWithImageFallback", () => {
  it("retries text-only when the provider rejects image input", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const readError = vi
      .fn()
      .mockReturnValueOnce(new Error("image input is not supported"))
      .mockReturnValueOnce(undefined);
    const clearError = vi.fn();
    const onRetry = vi.fn();

    await sendWithImageFallback(
      {
        text: "hello",
        files: [{ type: "file", mediaType: "image/png", url: "data:..." }],
      },
      send,
      readError,
      clearError,
      onRetry,
    );

    expect(onRetry).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual({ text: "hello", messageId: undefined });
    expect(clearError).toHaveBeenCalledTimes(2);
  });

  it("does not roll back the row on an id-based resend (edit/regenerate)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const readError = vi
      .fn()
      .mockReturnValueOnce(new Error("image input is not supported"))
      .mockReturnValueOnce(undefined);
    const clearError = vi.fn();
    const onRetry = vi.fn();

    await sendWithImageFallback(
      {
        text: "hello",
        messageId: "u-42",
        files: [{ type: "file", mediaType: "image/png", url: "data:..." }],
      },
      send,
      readError,
      clearError,
      onRetry,
    );

    // Removing the row would make sendMessage({messageId}) throw "not found"
    // and permanently delete the user's message.
    expect(onRetry).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual({ text: "hello", messageId: "u-42" });
  });

  it("throws when retry still fails", async () => {
    const err = new Error("image input is not supported");
    const send = vi.fn().mockResolvedValue(undefined);
    const readError = vi.fn().mockReturnValue(err);
    const clearError = vi.fn();

    await expect(
      sendWithImageFallback(
        {
          text: "hello",
          files: [{ type: "file", mediaType: "image/png", url: "data:..." }],
        },
        send,
        readError,
        clearError,
        vi.fn(),
      ),
    ).rejects.toThrow("image input is not supported");

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws non-image errors without retry", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const readError = vi.fn().mockReturnValue(new Error("rate limited"));
    const clearError = vi.fn();

    await expect(
      sendWithImageFallback({ text: "hello" }, send, readError, clearError, vi.fn()),
    ).rejects.toThrow("rate limited");

    expect(send).toHaveBeenCalledOnce();
  });
});
