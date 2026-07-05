import type { UIMessage } from "ai";
import { messagesSignature } from "./messages-signature";

export interface DocMessageSnapshot {
  path: string;
  messages: UIMessage[];
  signature: string;
  sessionId: string;
  docName: string;
}

/** Remember the last in-memory messages for an open document (survives chatId recreation). */
export function rememberDocMessageSnapshot(
  cache: Map<string, DocMessageSnapshot>,
  snapshot: DocMessageSnapshot,
): void {
  if (snapshot.messages.length === 0 && snapshot.signature === "") return;
  cache.set(snapshot.path, snapshot);
}

export function resolveOutgoingBeforeDocSwitch(options: {
  prevPath: string | null;
  pathChanged: boolean;
  currentMessages: UIMessage[];
  currentSignature: string;
  loadedSignature: string;
  cache: Map<string, DocMessageSnapshot>;
  currentSessionId: string;
  currentDocName: string;
}): {
  outgoing: UIMessage[];
  unsaved: boolean;
  savePath: string;
  saveName: string;
  saveSessionId: string;
} | null {
  const {
    prevPath,
    pathChanged,
    currentMessages,
    currentSignature,
    loadedSignature,
    cache,
    currentSessionId,
    currentDocName,
  } = options;

  const cached = pathChanged && prevPath ? cache.get(prevPath) : undefined;
  const outgoing = cached?.messages ?? currentMessages;
  const outgoingSignature = cached?.signature ?? currentSignature;
  const unsaved = outgoing.length > 0 && outgoingSignature !== loadedSignature;
  if (!unsaved) return null;

  const savePath = pathChanged && prevPath ? prevPath : (prevPath ?? "");
  if (!savePath) return null;

  const saveName =
    (pathChanged && prevPath ? cached?.docName : currentDocName) ||
    savePath.split(/[/\\]/).pop() ||
    savePath;
  const saveSessionId =
    pathChanged && prevPath ? (cached?.sessionId ?? currentSessionId) : currentSessionId;

  return { outgoing, unsaved: true, savePath, saveName, saveSessionId };
}

export function snapshotFromMessages(
  path: string,
  messages: UIMessage[],
  sessionId: string,
  docName: string,
): DocMessageSnapshot {
  return {
    path,
    messages,
    signature: messagesSignature(messages),
    sessionId,
    docName,
  };
}
