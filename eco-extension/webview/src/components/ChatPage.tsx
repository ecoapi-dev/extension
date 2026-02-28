import { useState, useEffect, useRef } from "react";
import { Send, Copy, Check, Play } from "lucide-react";
import { postMessage } from "../vscode";
import type { SuggestionContext, HostMessage } from "../types";

interface ChatPageProps {
  context: SuggestionContext | null;
}

interface Message {
  role: "ai" | "user";
  content: string;
  code?: string;
}

// Parse AI response to extract code blocks
function parseAIResponse(content: string): Message[] {
  const messages: Message[] = [];
  const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before the code block
    const textBefore = content.slice(lastIndex, match.index).trim();
    if (textBefore) {
      messages.push({ role: "ai", content: textBefore });
    }
    // The code block
    messages.push({ role: "ai", content: "Suggested fix:", code: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  const remaining = content.slice(lastIndex).trim();
  if (remaining) {
    messages.push({ role: "ai", content: remaining });
  }

  // If no messages were created, return the whole content as one message
  if (messages.length === 0 && content.trim()) {
    messages.push({ role: "ai", content: content.trim() });
  }

  return messages;
}

export function ChatPage({ context }: ChatPageProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasAutoSent = useRef(false);

  // Auto-send initial message when context changes
  useEffect(() => {
    if (context && !hasAutoSent.current && messages.length === 0) {
      hasAutoSent.current = true;
      const autoMessage = `Analyze this ${context.type} issue and suggest a fix: ${context.description}`;
      setMessages([{ role: "user", content: autoMessage }]);
      setIsStreaming(true);
      setStreamingContent("");
      postMessage({
        type: "chatMessage",
        text: autoMessage,
        context,
      });
    }
  }, [context, messages.length]);

  // Listen for messages from extension host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as HostMessage;
      switch (msg.type) {
        case "chatStreaming":
          setStreamingContent((prev) => prev + msg.chunk);
          break;
        case "chatDone":
          setIsStreaming(false);
          setStreamingContent("");
          const parsed = parseAIResponse(msg.fullContent);
          setMessages((prev) => [...prev, ...parsed]);
          break;
        case "error":
          setIsStreaming(false);
          setStreamingContent("");
          setMessages((prev) => [
            ...prev,
            { role: "ai", content: `Error: ${msg.message}` },
          ]);
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleCopy = (code: string, index: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleApply = (code: string) => {
    const file = context?.files[0];
    if (file) {
      postMessage({ type: "applyFix", code, file });
    }
  };

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;

    const text = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsStreaming(true);
    setStreamingContent("");
    postMessage({ type: "chatMessage", text, context });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Context pill */}
      {context && (
        <div
          className="px-4 py-1.5 shrink-0"
          style={{ borderBottom: "1px solid #131A13" }}
        >
          <span style={{ color: "#3A5A3A", fontSize: "0.6rem" }}>
            context: {context.type} · {context.files[0]}
          </span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg, i) => (
          <div key={i}>
            <span
              style={{
                color: "#2D4A2D",
                fontSize: "0.55rem",
                letterSpacing: "0.05em",
              }}
            >
              {msg.role === "ai" ? "eco" : "you"}
            </span>

            {msg.role === "user" ? (
              <p
                className="mt-0.5 pl-2"
                style={{
                  color: "#7EA87E",
                  fontSize: "0.75rem",
                  lineHeight: 1.6,
                  borderLeft: "1px solid #2a5a2a",
                }}
              >
                {msg.content}
              </p>
            ) : (
              <p
                className="mt-0.5"
                style={{ color: "#9EBF9E", fontSize: "0.75rem", lineHeight: 1.6 }}
              >
                {msg.content}
              </p>
            )}

            {msg.code && (
              <div
                className="mt-2 rounded overflow-hidden"
                style={{ border: "1px solid #1a2a1a" }}
              >
                <div
                  className="flex items-center justify-between px-3 py-1"
                  style={{
                    backgroundColor: "#0d120d",
                    borderBottom: "1px solid #1a2a1a",
                  }}
                >
                  <span style={{ color: "#2D4A2D", fontSize: "0.55rem" }}>
                    suggestion
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleCopy(msg.code!, i)}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded cursor-pointer"
                      style={{
                        fontSize: "0.55rem",
                        color: "#3A5A3A",
                        backgroundColor: "transparent",
                        border: "none",
                      }}
                    >
                      {copiedIndex === i ? <Check size={9} /> : <Copy size={9} />}
                      {copiedIndex === i ? "copied" : "copy"}
                    </button>
                    <button
                      onClick={() => handleApply(msg.code!)}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 rounded cursor-pointer"
                      style={{
                        fontSize: "0.55rem",
                        color: "#4EAA57",
                        backgroundColor: "transparent",
                        border: "none",
                      }}
                    >
                      <Play size={9} />
                      apply
                    </button>
                  </div>
                </div>
                <pre
                  className="px-3 py-2.5 overflow-x-auto"
                  style={{
                    fontSize: "0.7rem",
                    color: "#7EA87E",
                    lineHeight: 1.7,
                    backgroundColor: "#0a0f0a",
                  }}
                >
                  {msg.code}
                </pre>
              </div>
            )}
          </div>
        ))}

        {/* Streaming indicator */}
        {isStreaming && (
          <div>
            <span
              style={{
                color: "#2D4A2D",
                fontSize: "0.55rem",
                letterSpacing: "0.05em",
              }}
            >
              eco
            </span>
            <p
              className="mt-0.5"
              style={{ color: "#9EBF9E", fontSize: "0.75rem", lineHeight: 1.6 }}
            >
              {streamingContent || "Thinking..."}
            </p>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="px-4 py-2.5 shrink-0"
        style={{ borderTop: "1px solid #1a2a1a" }}
      >
        <div
          className="flex items-center rounded overflow-hidden"
          style={{ border: "1px solid #1a2a1a" }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ask a follow-up..."
            disabled={isStreaming}
            className="flex-1 px-3 py-2 bg-transparent outline-none"
            style={{
              color: "#9EBF9E",
              fontSize: "0.75rem",
              opacity: isStreaming ? 0.5 : 1,
            }}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="px-2.5 py-2 cursor-pointer"
            style={{
              color: input.trim() && !isStreaming ? "#4EAA57" : "#3A5A3A",
              backgroundColor: "transparent",
              border: "none",
            }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
