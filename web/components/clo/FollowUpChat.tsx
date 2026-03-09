"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { marked } from "marked";
import type { PanelMember } from "@/lib/clo/types";

type Mode = "analyst" | "ask-panel" | "ask-member" | "debate";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface FollowUpChatProps {
  apiUrl: string;
  members: PanelMember[];
  title?: string;
  modes?: Mode[];
  defaultMode?: Mode;
  placeholders?: Partial<Record<Mode, string>>;
}

function escapeRegex(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSpeakerBlocks(
  content: string,
  members: PanelMember[]
): { speaker: string; content: string }[] {
  const memberNames = members.map((m) => m.name);
  if (memberNames.length === 0) {
    return [{ speaker: "", content }];
  }
  const pattern = new RegExp(`\\*\\*(${memberNames.map(escapeRegex).join("|")}):\\*\\*`, "g");

  const blocks: { speaker: string; content: string }[] = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const preceding = content.slice(lastIndex, match.index).trim();
      if (preceding && blocks.length === 0) {
        blocks.push({ speaker: "", content: preceding });
      } else if (preceding && blocks.length > 0) {
        blocks[blocks.length - 1].content += "\n\n" + preceding;
      }
    }
    blocks.push({ speaker: match[1], content: "" });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (blocks.length > 0) {
      blocks[blocks.length - 1].content += remaining;
    } else {
      blocks.push({ speaker: "", content: remaining });
    }
  }

  if (blocks.length === 0) {
    blocks.push({ speaker: "", content });
  }

  return blocks;
}

const DEFAULT_PLACEHOLDERS: Record<Mode, string> = {
  analyst: "Ask your senior analyst about this credit...",
  "ask-panel": "Ask the panel a question...",
  "ask-member": "", // filled dynamically
  debate: "What should the panel debate?",
};

export default function FollowUpChat({
  apiUrl,
  members,
  title = "Q&A",
  modes = ["analyst", "ask-panel", "ask-member", "debate"],
  defaultMode,
  placeholders,
}: FollowUpChatProps) {
  const [mode, setMode] = useState<Mode>(defaultMode || modes[0]);
  const [selectedMember, setSelectedMember] = useState(members[0]?.name || "");
  const [question, setQuestion] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    fetch(apiUrl)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const msgs: ChatMessage[] = [];
          for (const fu of data) {
            msgs.push({ role: "user", content: fu.question });
            if (fu.response_md) msgs.push({ role: "assistant", content: fu.response_md });
          }
          setMessages(msgs);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [apiUrl]);

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

  async function handleSubmit() {
    if (!question.trim() || isStreaming) return;

    const userMessage = question.trim();
    setQuestion("");
    setIsStreaming(true);

    const updatedMessages: ChatMessage[] = [...messages, { role: "user", content: userMessage }];
    setMessages(updatedMessages);

    // Send prior history WITHOUT the current question — the server appends it
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    const body = {
      question: userMessage,
      mode,
      targetMember: mode === "ask-member" ? selectedMember : undefined,
      history,
    };

    const res = await fetch(apiUrl, {
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
          if (data.type === "done") {
            setIsStreaming(false);
          }
        } catch {
          // skip malformed events
        }
      }
    }

    setIsStreaming(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function renderAssistantMessage(content: string) {
    const blocks = parseSpeakerBlocks(content, members);
    if (blocks.length === 1 && !blocks[0].speaker) {
      return (
        <div
          className="markdown-content"
          dangerouslySetInnerHTML={{
            __html: marked.parse(content, { async: false }) as string,
          }}
        />
      );
    }
    return blocks.map((block, i) => {
      if (!block.speaker) {
        return (
          <div key={i} className="markdown-content" dangerouslySetInnerHTML={{
            __html: marked.parse(block.content, { async: false }) as string,
          }} />
        );
      }
      const member = members.find((m) => m.name === block.speaker);
      return (
        <div key={i} className="ic-debate-exchange">
          <div className="ic-debate-speaker">
            {member?.avatarUrl ? (
              <img
                src={member.avatarUrl}
                alt={block.speaker}
                style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover" }}
              />
            ) : (
              <span className="ic-debate-speaker-dot" />
            )}
            {block.speaker}
          </div>
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{
              __html: marked.parse(block.content, { async: false }) as string,
            }}
          />
        </div>
      );
    });
  }

  if (!loaded) return null;

  return (
    <div style={{ marginTop: "1rem" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.2rem", marginBottom: "1rem" }}>
        {title}
      </h2>

      {messages.length > 0 && (
        <div ref={threadRef} className="chat-thread">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div className="chat-message-user">{msg.content}</div>
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
                {isSearching ? "Searching the web..." : "Panel is deliberating..."}
              </span>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {modes.map((m) => (
          <label
            key={m}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.4rem 0.8rem",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${mode === m ? "var(--color-accent)" : "var(--color-border)"}`,
              background: mode === m ? "var(--color-accent-subtle)" : "transparent",
              color: mode === m ? "var(--color-accent)" : "var(--color-text-secondary)",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: mode === m ? 600 : 400,
            }}
          >
            <input
              type="radio"
              name="clo-follow-up-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
              style={{ display: "none" }}
            />
            {m === "analyst" ? "Analyst" : m === "ask-panel" ? "Ask Panel" : m === "ask-member" ? "Ask Member" : "Request Debate"}
          </label>
        ))}
      </div>

      <div className="chat-input-container">
        {mode === "ask-member" && members.length > 0 && (
          <div className="chat-input-character-row">
            <span className="chat-input-character-label">Speaking with</span>
            <select
              value={selectedMember}
              onChange={(e) => setSelectedMember(e.target.value)}
              className="chat-input-character-select"
            >
              {members.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => { setQuestion(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          className="chat-input-textarea"
          placeholder={
            placeholders?.[mode]
              || (mode === "ask-member" ? `Ask ${selectedMember} a question...` : DEFAULT_PLACEHOLDERS[mode])
          }
          rows={2}
          disabled={isStreaming}
        />

        <div className="chat-input-toolbar">
          <div className="chat-input-toolbar-left" />
          <div className="chat-input-toolbar-right">
            <button
              onClick={handleSubmit}
              disabled={isStreaming || !question.trim()}
              className="chat-input-btn chat-input-btn-submit"
            >
              {isStreaming ? "Deliberating..." : "Ask"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
