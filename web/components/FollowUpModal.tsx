"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { marked } from "marked";
import { parseFollowUpResponse, getLoadingMessage } from "@/lib/follow-up-rendering";
import { findAvatarUrl } from "@/lib/character-utils";
import AttachmentWidget, { type AttachedFile, type AttachmentWidgetHandle } from "@/components/AttachmentWidget";
import { useAssemblyAccess, useAssemblyTrial } from "@/lib/assembly-context";

const FREE_TRIAL_INTERACTION_LIMIT = 5;
import type { FollowUp } from "@/lib/types";

type Mode = "ask-assembly" | "ask-character" | "ask-library" | "debate";
type PageType = "synthesis" | "character" | "iteration" | "references" | "deliverables" | "trajectory";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface FollowUpModalProps {
  assemblyId: string;
  characters: string[];
  avatarUrlMap?: Record<string, string>;
  currentPage: string;
  defaultCharacter?: string;
  pageType?: PageType;
  followUps?: FollowUp[];
  onUpdateDeliverable?: (conversationHistory: { role: string; content: string }[]) => Promise<void>;
}

function getPageConfig(pageType: PageType | undefined, characterName?: string) {
  switch (pageType) {
    case "character":
      return {
        heading: `Ask ${characterName ?? "Character"}`,
        fixedMode: "ask-character" as Mode,
        showModeSelector: false,
        showChallenge: true,
        submitLabel: "Ask",
      };
    case "iteration":
      return {
        heading: "Debate",
        fixedMode: "debate" as Mode,
        showModeSelector: false,
        showChallenge: false,
        submitLabel: "Debate",
      };
    case "references":
      return {
        heading: "Explore Babylon\u2019s Library",
        fixedMode: "ask-library" as Mode,
        showModeSelector: false,
        showChallenge: false,
        submitLabel: "Ask",
      };
    default:
      return {
        heading: "Ask the Panel",
        fixedMode: null,
        showModeSelector: true,
        showChallenge: false,
        submitLabel: "Ask",
      };
  }
}

export default function FollowUpModal({
  assemblyId,
  characters,
  avatarUrlMap = {},
  currentPage,
  defaultCharacter,
  pageType,
  followUps = [],
  onUpdateDeliverable,
}: FollowUpModalProps) {
  const accessLevel = useAssemblyAccess();
  const { isFreeTrialAssembly, trialInteractionsUsed } = useAssemblyTrial();
  const config = getPageConfig(pageType, defaultCharacter);

  const trialExhausted = isFreeTrialAssembly && trialInteractionsUsed >= FREE_TRIAL_INTERACTION_LIMIT;
  const trialRemaining = FREE_TRIAL_INTERACTION_LIMIT - trialInteractionsUsed;

  const [mode, setMode] = useState<Mode>(config.fixedMode ?? (defaultCharacter ? "ask-character" : "ask-assembly"));
  const [question, setQuestion] = useState("");
  const [selectedCharacter, setSelectedCharacter] = useState(defaultCharacter || characters[0] || "");
  const [isChallenge, setIsChallenge] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isUpdatingDeliverable, setIsUpdatingDeliverable] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const initial: ChatMessage[] = [];
    for (const fu of followUps) {
      const ctx = typeof fu.context === "object" && "page" in fu.context
        ? (fu.context as { page: string }).page
        : fu.context;
      if (ctx !== currentPage) continue;
      initial.push({ role: "user", content: fu.question });
      if (fu.raw) initial.push({ role: "assistant", content: fu.raw });
    }
    return initial;
  });
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachHandle, setAttachHandle] = useState<AttachmentWidgetHandle | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const handleScroll = () => {
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (threadRef.current && isNearBottomRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  const activeMode = config.fixedMode ?? mode;

  if (accessLevel === "read") return null;

  async function handleSubmit(challengeOverride = false) {
    if (!question.trim() || isStreaming) return;

    const userMessage = question.trim();
    setQuestion("");
    setIsStreaming(true);
    setIsChallenge(false);

    const updatedMessages: ChatMessage[] = [...messages, { role: "user", content: userMessage }];
    setMessages(updatedMessages);

    let fileRefs: { name: string; type: string; content: string }[] = [];
    if (attachedFiles.length > 0) {
      fileRefs = await Promise.all(
        attachedFiles.map(async (af) => ({
          name: af.file.name,
          type: af.file.type || "text/plain",
          content: await af.file.text(),
        }))
      );
    }

    // Send prior history WITHOUT the current question — the server appends it
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    const body = {
      question: userMessage,
      mode: activeMode,
      characters: activeMode === "ask-character" ? [selectedCharacter] : [],
      context: { page: currentPage },
      challenge: challengeOverride,
      files: fileRefs.length > 0 ? fileRefs : undefined,
      history,
    };

    const res = await fetch(`/api/assemblies/${assemblyId}/follow-ups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      setMessages((prev) => [...prev, { role: "assistant", content: "Error: Failed to get response" }]);
      setIsStreaming(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === "searching") {
            setIsSearching(true);
          }
          if (data.type === "text") {
            setIsSearching(false);
            accumulated += data.content;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && prev.length === updatedMessages.length + 1) {
                return [...prev.slice(0, -1), { role: "assistant", content: accumulated }];
              }
              return [...prev, { role: "assistant", content: accumulated }];
            });
          }
          if (data.type === "error") {
            accumulated += `\n\nError: ${data.content}`;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return [...prev.slice(0, -1), { role: "assistant", content: accumulated }];
              }
              return [...prev, { role: "assistant", content: accumulated }];
            });
          }
          if (data.type === "done") {
            setIsStreaming(false);
          }
        } catch {
          // skip malformed events
        }
      }
    }

    setIsStreaming(false);
    setAttachedFiles([]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const hasFullExchange = messages.length >= 2
    && messages.some((m) => m.role === "user")
    && messages.some((m) => m.role === "assistant");
  const showUpdateDeliverable = onUpdateDeliverable && hasFullExchange && !isStreaming;

  async function handleUpdateDeliverable() {
    if (!onUpdateDeliverable || isUpdatingDeliverable) return;
    setIsUpdatingDeliverable(true);
    await onUpdateDeliverable(messages.map((m) => ({ role: m.role, content: m.content })));
    setIsUpdatingDeliverable(false);
  }

  const loadingMsg = getLoadingMessage(activeMode, isChallenge);

  function renderAssistantMessage(content: string) {
    const speakerBlocks = parseFollowUpResponse(content, characters);
    if (speakerBlocks.length === 1 && !speakerBlocks[0].speaker) {
      return (
        <div
          className="markdown-content"
          dangerouslySetInnerHTML={{
            __html: marked.parse(content, { async: false }) as string,
          }}
        />
      );
    }
    return speakerBlocks.map((block, i) => {
      const url = findAvatarUrl(block.speaker, avatarUrlMap);
      return (
        <div key={i} className="follow-up-exchange">
          <div className="debate-speaker">
            {url ? (
              <img src={url} alt={block.speaker} style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <span className="debate-speaker-dot" style={{ background: block.color }} />
            )}
            {block.speaker}
          </div>
          <div
            className="debate-content"
            dangerouslySetInnerHTML={{
              __html: marked.parse(block.content, { async: false }) as string,
            }}
          />
        </div>
      );
    });
  }

  return (
    <div style={{ marginTop: "2rem", borderTop: "1px solid var(--color-border-light)", paddingTop: "1.5rem" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.2rem", marginBottom: "1rem" }}>
        {config.heading}
      </h2>

      {messages.length > 0 && (
        <div ref={threadRef} className="chat-thread">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div className="chat-message-user">
                  {msg.content}
                </div>
              ) : (
                <div className="chat-message-assistant">
                  {renderAssistantMessage(msg.content)}
                </div>
              )}
              {msg.role === "assistant" && i < messages.length - 1 && (
                <div className="chat-thread-divider" />
              )}
            </div>
          ))}
          {isStreaming && messages[messages.length - 1]?.role === "user" && (
            <div className="chat-message-assistant">
              <span style={{ color: "var(--color-text-muted)", fontStyle: "italic", fontSize: "0.85rem" }}>
                {isSearching ? "Searching the web..." : loadingMsg}
              </span>
            </div>
          )}
        </div>
      )}

      {config.showModeSelector && (
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          <label style={{
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.4rem 0.8rem",
            borderRadius: "var(--radius-sm)",
            border: `1px solid ${mode === "ask-assembly" ? "var(--color-accent)" : "var(--color-border)"}`,
            background: mode === "ask-assembly" ? "var(--color-accent-subtle)" : "transparent",
            color: mode === "ask-assembly" ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            fontSize: "0.85rem",
            fontWeight: mode === "ask-assembly" ? 600 : 400,
          }}>
            <input
              type="radio"
              name="follow-up-mode"
              checked={mode === "ask-assembly"}
              onChange={() => setMode("ask-assembly")}
              style={{ display: "none" }}
            />
            &#9752; Ask Panel
          </label>
          <label style={{
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.4rem 0.8rem",
            borderRadius: "var(--radius-sm)",
            border: `1px solid ${mode === "ask-character" ? "var(--color-accent)" : "var(--color-border)"}`,
            background: mode === "ask-character" ? "var(--color-accent-subtle)" : "transparent",
            color: mode === "ask-character" ? "var(--color-accent)" : "var(--color-text-secondary)",
            cursor: "pointer",
            fontSize: "0.85rem",
            fontWeight: mode === "ask-character" ? 600 : 400,
          }}>
            <input
              type="radio"
              name="follow-up-mode"
              checked={mode === "ask-character"}
              onChange={() => setMode("ask-character")}
              style={{ display: "none" }}
            />
            &#9823; Ask Character
          </label>
        </div>
      )}

      <div className="chat-input-container">
        {activeMode === "ask-character" && characters.length > 0 && (
          <div className="chat-input-character-row">
            <span className="chat-input-character-label">Speaking with</span>
            <select
              value={selectedCharacter}
              onChange={(e) => setSelectedCharacter(e.target.value)}
              className="chat-input-character-select"
            >
              {characters.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        )}

        <AttachmentWidget files={attachedFiles} onChange={setAttachedFiles} disabled={isStreaming} hideButton handleRef={setAttachHandle} />

        {isFreeTrialAssembly && !trialExhausted && (
          <p style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", margin: "0 0 0.5rem" }}>
            {trialRemaining} of {FREE_TRIAL_INTERACTION_LIMIT} interactions remaining
          </p>
        )}

        {trialExhausted ? (
          <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)", margin: "0.5rem 0" }}>
            Free trial interactions used.{" "}
            <a href="/onboarding" style={{ color: "var(--color-accent)", textDecoration: "underline" }}>
              Add your API key
            </a>{" "}
            for unlimited access.
          </p>
        ) : (
          <textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => { setQuestion(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            className="chat-input-textarea"
            placeholder={
              activeMode === "ask-character"
                ? `Ask ${selectedCharacter} a question...`
                : activeMode === "ask-library"
                  ? "Ask about these sources..."
                  : activeMode === "debate"
                    ? "What should the panel debate?"
                    : "Ask the panel a question..."
            }
            rows={2}
            disabled={isStreaming}
          />
        )}

        {!trialExhausted && <div className="chat-input-toolbar">
          <div className="chat-input-toolbar-left">
            <button
              type="button"
              className="chat-input-attach-btn"
              onClick={() => attachHandle?.openPicker()}
              disabled={isStreaming}
              title="Attach files"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 8.5l-5.5 5.5a4 4 0 01-5.66-5.66l7.08-7.07a2.67 2.67 0 013.77 3.77L6.6 12.1a1.33 1.33 0 01-1.88-1.88L11 3.94" />
              </svg>
            </button>
          </div>
          <div className="chat-input-toolbar-right">
            {showUpdateDeliverable && (
              <button
                onClick={handleUpdateDeliverable}
                disabled={isUpdatingDeliverable}
                className="chat-input-btn chat-input-btn-update-deliverable"
              >
                {isUpdatingDeliverable ? "Updating..." : "Update Deliverable"}
              </button>
            )}
            {config.showChallenge && (
              <button
                onClick={() => handleSubmit(true)}
                disabled={isStreaming || !question.trim()}
                className="chat-input-btn chat-input-btn-challenge"
              >
                Challenge
              </button>
            )}
            <button
              onClick={() => handleSubmit()}
              disabled={isStreaming || !question.trim()}
              className="chat-input-btn chat-input-btn-submit"
            >
              {isStreaming ? loadingMsg : config.submitLabel}
            </button>
          </div>
        </div>}
      </div>
    </div>
  );
}
