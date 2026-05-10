import { describe, expect, it, vi } from "vitest";
import { processAnthropicStream } from "../claude-stream";

const encoder = new TextEncoder();

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function readerFrom(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }).getReader();
}

describe("processAnthropicStream", () => {
  it("forwards text deltas and returns full text after message_stop", async () => {
    const enqueue = vi.fn();
    const controller = { enqueue } as unknown as ReadableStreamDefaultController;
    const reader = readerFrom([
      sse({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "[]" },
      }),
      sse({ type: "message_stop" }),
    ]);

    const text = await processAnthropicStream(reader, controller, encoder);

    expect(text).toBe("[]");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("throws when Anthropic closes before a terminal message_stop event", async () => {
    const enqueue = vi.fn();
    const controller = { enqueue } as unknown as ReadableStreamDefaultController;
    const reader = readerFrom([
      sse({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "[]" },
      }),
    ]);

    await expect(processAnthropicStream(reader, controller, encoder)).rejects.toThrow(
      "Anthropic stream ended before completion",
    );
  });

  it("throws on max_tokens before emitting a successful completion", async () => {
    const enqueue = vi.fn();
    const controller = { enqueue } as unknown as ReadableStreamDefaultController;
    const reader = readerFrom([
      sse({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      }),
      sse({ type: "message_stop" }),
    ]);

    await expect(processAnthropicStream(reader, controller, encoder)).rejects.toThrow(
      "Anthropic response was truncated at max_tokens",
    );
  });

  it("throws Anthropic stream error events with their upstream message", async () => {
    const enqueue = vi.fn();
    const controller = { enqueue } as unknown as ReadableStreamDefaultController;
    const reader = readerFrom([
      sse({
        type: "error",
        error: { message: "rate limit exceeded" },
      }),
    ]);

    await expect(processAnthropicStream(reader, controller, encoder)).rejects.toThrow(
      "rate limit exceeded",
    );
  });
});
