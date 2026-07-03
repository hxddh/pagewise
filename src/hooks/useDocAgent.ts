import { useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DirectChatTransport } from "ai";
import { createDocAgent } from "../lib/agent";

export function useDocAgent() {
  const agentRef = useRef(createDocAgent());
  const transportRef = useRef(
    new DirectChatTransport({ agent: agentRef.current }),
  );

  const chat = useChat({
    transport: transportRef.current,
  });

  return useMemo(
    () => ({
      messages: chat.messages,
      sendMessage: chat.sendMessage,
      status: chat.status,
      error: chat.error,
      stop: chat.stop,
      setMessages: chat.setMessages,
    }),
    [chat.messages, chat.status, chat.error, chat.sendMessage, chat.stop, chat.setMessages],
  );
}
