"use client";

import { useState, useRef, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { marked } from "marked";
import Link from "next/link";
import AttachmentWidget, { type AttachedFile, type AttachmentWidgetHandle } from "@/components/AttachmentWidget";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  fileNames?: string[];
}

export default function CLOChatPage() {
  return (
    <Suspense>
      <CLOChatInner />
    </Suspense>
  );
}

function CLOChatInner() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const attachmentHandleRef = useRef<AttachmentWidgetHandle | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    // Skip loading previous conversation if ?new=1 is in the URL
    if (searchParams.get("new") === "1") {
      setLoaded(true);
      return;
    }
    fetch("/api/clo/chat")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.id) {
          setConversationId(data.id);
          setMessages(data.messages || []);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [searchParams]);

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
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    const attachedFiles = [...files];
    setInput("");
    setFiles([]);
    setIsStreaming(true);

    const now = new Date().toISOString();
    const fileNames = attachedFiles.map((f) => f.file.name);
    const newUserMsg: ChatMessage = {
      role: "user",
      content: userMessage,
      timestamp: now,
      fileNames: fileNames.length > 0 ? fileNames : undefined,
    };
    const updatedMessages = [...messages, newUserMsg];
    setMessages(updatedMessages);

    let res: Response;
    if (attachedFiles.length > 0) {
      const formData = new FormData();
      formData.append("message", userMessage);
      if (conversationId) formData.append("conversationId", conversationId);
      for (const af of attachedFiles) {
        formData.append("files", af.file);
      }
      res = await fetch("/api/clo/chat", { method: "POST", body: formData });
    } else {
      res = await fetch("/api/clo/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, conversationId }),
      });
    }

    if (!res.ok || !res.body) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error: Failed to get response", timestamp: now },
      ]);
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
                return [...prev.slice(0, -1), { role: "assistant", content: accumulated, timestamp: now }];
              }
              return [...prev, { role: "assistant", content: accumulated, timestamp: now }];
            });
          }
          if (data.type === "done") {
            if (data.conversationId) {
              setConversationId(data.conversationId);
              // Clear ?new=1 so page reload loads the saved conversation
              router.replace("/clo/chat");
            }
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

  function handleNewConversation() {
    setMessages([]);
    setConversationId(null);
    router.push("/clo/chat?new=1");
  }

  if (!loaded) return null;

  return (
    <div className="ic-dashboard" style={{ maxWidth: 900, margin: "0 auto" }}>
      <header className="ic-dashboard-header">
        <div>
          <h1>CLO Analyst</h1>
          <p>Your senior credit analyst with full CLO context</p>
        </div>
        <div className="ic-dashboard-actions">
          <button onClick={handleNewConversation} className="btn-secondary">
            New Conversation
          </button>
          <Link href="/clo" className="btn-secondary">
            Dashboard
          </Link>
        </div>
      </header>

      {messages.length === 0 && (
        <div style={{
          textAlign: "center",
          padding: "3rem 1rem",
          color: "var(--color-text-muted)",
        }}>
          <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
            Ask your analyst anything about your CLO
          </p>
          <p style={{ fontSize: "0.85rem" }}>
            Compliance checks, trade ideas, portfolio optimization, loan deep-dives...
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <div ref={threadRef} className="chat-thread" style={{ minHeight: 300, maxHeight: "60vh" }}>
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div className="chat-message-user">
                  {msg.content}
                  {msg.fileNames && msg.fileNames.length > 0 && (
                    <div className="chat-message-files">
                      {msg.fileNames.map((name, j) => (
                        <span key={j} className="chat-message-file-chip">📎 {name}</span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="chat-message-assistant">
                  <div
                    className="markdown-content"
                    dangerouslySetInnerHTML={{
                      __html: marked.parse(msg.content, { async: false }) as string,
                    }}
                  />
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
                {isSearching ? "Searching the web..." : "Analyst is thinking..."}
              </span>
            </div>
          )}
        </div>
      )}

      <div
        className={`chat-input-container${dragOver ? " drag-over" : ""}`}
        style={{ marginTop: "1rem" }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!isStreaming && e.dataTransfer.files.length > 0) {
            attachmentHandleRef.current?.addFiles(e.dataTransfer.files);
          }
        }}
      >
        <AttachmentWidget
          files={files}
          onChange={setFiles}
          disabled={isStreaming}
          hideButton
          handleRef={(h) => { attachmentHandleRef.current = h; }}
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          className="chat-input-textarea"
          placeholder="Ask about compliance, trade ideas, portfolio optimization..."
          rows={2}
          disabled={isStreaming}
        />
        <div className="chat-input-toolbar">
          <div className="chat-input-toolbar-left">
            <button
              type="button"
              className="chat-input-btn chat-input-btn-attach"
              onClick={() => attachmentHandleRef.current?.openPicker()}
              disabled={isStreaming}
              title="Attach files"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 8.5l-5.5 5.5a4 4 0 01-5.66-5.66l7.08-7.07a2.67 2.67 0 013.77 3.77L6.6 12.1a1.33 1.33 0 01-1.88-1.88L11 3.94" />
              </svg>
            </button>
          </div>
          <div className="chat-input-toolbar-right">
            <button
              onClick={handleSubmit}
              disabled={isStreaming || (!input.trim() && files.length === 0)}
              className="chat-input-btn chat-input-btn-submit"
            >
              {isStreaming ? "Thinking..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
