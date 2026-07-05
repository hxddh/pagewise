import type { Context, ToolSet } from "@ai-sdk/provider-utils";
import type { Agent } from "ai";
import {
  convertToModelMessages,
  toUIMessageStream,
  type ChatTransport,
  type UIMessageChunk,
} from "ai";
import { messagesSignature } from "./messages-signature";
import { validateChatMessagesForSend } from "./validate-chat-messages";
import type { ProviderId } from "./types";
import { resolveStreamingTransform } from "./stream-transform";
import { clearAgentProgress, subscribeAgentProgress } from "./agent-progress";
import { wrapStreamWithAgentProgress } from "./inject-progress-stream";
import { setAgentRunAbortSignal, clearAgentRunAbortSignal } from "./vision-index";
import {
  createUsageMetadataTracker,
  type PageWiseMessageMetadata,
  type PageWiseUIMessage,
} from "./message-metadata";

export interface PagewiseChatTransportOptions<
  CALL_OPTIONS,
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context,
> {
  agent: Agent<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT>;
  onError?: (error: unknown) => string;
  resolveModelLabel: () => Promise<string>;
  resolveProvider: () => Promise<ProviderId>;
  /** Sync UI when send-time validation repairs history (may drop trailing rows). */
  onMessagesRepaired?: (messages: PageWiseUIMessage[]) => void;
}

export class PagewiseChatTransport<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  RUNTIME_CONTEXT extends Context = Context,
> implements ChatTransport<PageWiseUIMessage>
{
  private readonly agent: Agent<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT>;
  private readonly onError: (error: unknown) => string;
  private readonly resolveModelLabel: () => Promise<string>;
  private readonly resolveProvider: () => Promise<ProviderId>;
  private readonly onMessagesRepaired?: (messages: PageWiseUIMessage[]) => void;

  constructor({
    agent,
    onError = () => "An error occurred.",
    resolveModelLabel,
    resolveProvider,
    onMessagesRepaired,
  }: PagewiseChatTransportOptions<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT>) {
    this.agent = agent;
    this.onError = onError;
    this.resolveModelLabel = resolveModelLabel;
    this.resolveProvider = resolveProvider;
    this.onMessagesRepaired = onMessagesRepaired;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<PageWiseUIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    clearAgentProgress();

    const provider = await this.resolveProvider();
    const validatedMessages = await validateChatMessagesForSend({
      messages,
      provider,
      tools: this.agent.tools as Parameters<typeof validateChatMessagesForSend>[0]["tools"],
    });
    if (messagesSignature(validatedMessages) !== messagesSignature(messages)) {
      this.onMessagesRepaired?.(validatedMessages);
    }

    const modelMessages = await convertToModelMessages(validatedMessages, {
      tools: this.agent.tools,
    });

    const model = await this.resolveModelLabel();
    const tracker = createUsageMetadataTracker(model);
    tracker.reset();

    const earlyProgress: Array<{ message: string; phase?: "tool" | "index" | "search" | "read" }> =
      [];
    const unsubEarly = subscribeAgentProgress((payload) => {
      earlyProgress.push(payload);
    });

    let result;
    try {
      setAgentRunAbortSignal(abortSignal);
      result = await this.agent.stream({
        prompt: modelMessages,
        abortSignal,
        experimental_transform: resolveStreamingTransform(),
        onStepEnd: tracker.onStepEnd,
      } as Parameters<Agent<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT>["stream"]>[0]);

      const uiStream = toUIMessageStream({
        stream: result.stream,
        tools: this.agent.tools,
        originalMessages: validatedMessages,
        onError: this.onError,
        messageMetadata: tracker.messageMetadata,
      });

      return wrapStreamWithAgentProgress(uiStream, earlyProgress, {
        onStreamEnd: () => {
          unsubEarly();
          clearAgentRunAbortSignal();
        },
      });
    } catch (error) {
      unsubEarly();
      clearAgentRunAbortSignal();
      throw error;
    }
  }

  async reconnectToStream(
    _options: Parameters<ChatTransport<PageWiseUIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

export type { PageWiseMessageMetadata };
