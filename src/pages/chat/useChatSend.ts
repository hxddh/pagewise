import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { LoadedDocument } from "../../lib/types";
import type { DocAgent, SendDocumentMessageOptions } from "../../hooks/useDocAgent";

export interface ChatSend {
  /** Attempt a send. True when the text left the composer. */
  send: (text: string, options: { webSearch: boolean }) => Promise<boolean>;
  /** Regenerate the newest answer, reusing the page the reader is on now. */
  regenerate: () => Promise<void>;
}

export interface ChatSendDeps {
  doc: LoadedDocument | null;
  /** The page the reader is on. */
  page: number;
  includeViewingPage: boolean;
  agent: DocAgent;
  /** A stream is open; chatLoading means a correction cannot be steered yet;
   *  interactionBusy refuses a send that is not a steer. */
  busy: boolean;
  chatLoading: boolean;
  interactionBusy: boolean;
  hasApiKey: boolean;
  onConfigureApi: () => void;
  onComposerDraftChange: (value: string) => void;
  /** The composer's current text, so a failed send is only restored when the
   *  reader has not typed something newer. */
  readDraft: () => string;
  /** Cleared when a send goes: the reader is looking at the tail again. */
  stickToBottomRef: RefObject<boolean>;
}

/**
 * Sending, and handing a correction to the run already going.
 *
 * Sending during a run steers it rather than being refused. Until 7.6 that
 * meant stopping the run and starting another — its cost was understated:
 * page text is free to re-read from the local cache and is billed again as
 * tokens the moment it re-enters a fresh context. The restart path survives
 * for the cases injection cannot serve: no run to inject into, or a run whose
 * remaining steps have run out.
 */
export function useChatSend({
  doc,
  page,
  includeViewingPage,
  agent,
  busy,
  chatLoading,
  interactionBusy,
  hasApiKey,
  onConfigureApi,
  onComposerDraftChange,
  readDraft,
  stickToBottomRef,
}: ChatSendDeps): ChatSend {
  // MessageAssistantFooter's memo comparator intentionally ignores
  // onRegenerate, so a footer already rendered can hold an older closure.
  // Reading the page through refs makes Regenerate use the page the reader is on.
  const pageRef = useRef(page);
  pageRef.current = page;
  const includeRef = useRef(includeViewingPage);
  includeRef.current = includeViewingPage;

  const send = useCallback(
    async (text: string, options: { webSearch: boolean }): Promise<boolean> => {
      const steering = busy && !chatLoading;
      if (interactionBusy && !steering) return false;
      if (steering && !hasApiKey) {
        onConfigureApi();
        return false;
      }
      if (steering && doc) {
        // steerRun both queues the note for the loop and records it on the
        // user turn that started the run (see useDocAgent): queueing without
        // recording would clear the composer and leave no trace of why.
        if (agent.run.steer(text)) {
          onComposerDraftChange("");
          stickToBottomRef.current = true;
          return true;
        }
        // The run has taken all the corrections it will, so fall through to
        // the restart path rather than dropping what was typed.
      }
      // Only a missing API key is a hard blocker; tool-capability is a
      // heuristic guess, so the provider surfaces the real error instead.
      if (!hasApiKey) {
        onConfigureApi();
        return false;
      }
      if (!doc) return false;
      if (steering) {
        const idle = await agent.run.waitForIdle();
        if (!idle) return false;
      }
      stickToBottomRef.current = true;
      onComposerDraftChange("");
      const payload: SendDocumentMessageOptions = {
        text,
        path: doc.path,
        docName: doc.name,
        docKind: doc.kind,
        viewingPage: page,
        totalPages: doc.totalPages,
        includeViewingPage,
        webSearch: options.webSearch,
      };
      try {
        const sent = await agent.run.send(payload);
        // Restore a failed send's text only if no newer draft exists.
        if (!sent && !readDraft()) onComposerDraftChange(text);
        return sent;
      } catch {
        if (!readDraft()) onComposerDraftChange(text);
        return false;
      }
    },
    [
      busy,
      chatLoading,
      interactionBusy,
      hasApiKey,
      onConfigureApi,
      doc,
      agent,
      page,
      includeViewingPage,
      onComposerDraftChange,
      readDraft,
      stickToBottomRef,
    ],
  );

  const regenerate = useCallback(async () => {
    if (!doc || interactionBusy) return;
    // Tool-capability is a heuristic; only a missing key hard-blocks (see send).
    if (!hasApiKey) {
      onConfigureApi();
      return;
    }
    stickToBottomRef.current = true;
    await agent.run.regenerate({
      path: doc.path,
      docName: doc.name,
      docKind: doc.kind,
      viewingPage: pageRef.current,
      totalPages: doc.totalPages,
      includeViewingPage: includeRef.current,
    });
  }, [doc, agent, interactionBusy, hasApiKey, onConfigureApi, stickToBottomRef]);

  return { send, regenerate };
}
