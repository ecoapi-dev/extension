import { useState, useEffect, useRef } from "react";
import { Markdown } from "./Markdown";
import { postMessage, getVsCodeApi } from "../vscode";
import type { SuggestionContext, HostMessage } from "../types";

interface ChatPageProps {
  context: SuggestionContext | null;
}

interface Message {
  role: "ai" | "user";
  content: string;
  applyFix?: {
    code: string;
    file: string;
    line?: number;
  };
}

const MODEL_GROUPS = [
  {
    label: "ECO AI",
    models: [
      { id: "eco-ai", name: "Llama 3.1 (Free)" },
    ],
  },
  {
    label: "GPT",
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "gpt-4.1", name: "GPT-4.1" },
    ],
  },
  {
    label: "Reasoning",
    models: [
      { id: "o3-mini", name: "o3 Mini" },
      { id: "o1", name: "o1" },
      { id: "o3", name: "o3" },
    ],
  },
];

const AVAILABLE_MODEL_IDS = MODEL_GROUPS.flatMap((group) => group.models.map((m) => m.id));

function isGptModel(model: string): boolean {
  return model.startsWith("gpt-");
}

function toCodeFocusedPrompt(text: string): string {
  return `${text}

Return an actual code solution, not only explanation.
- Include at least one fenced code block.
- Prefer complete replacement snippets for the target file section.
- Keep non-code commentary to 1-2 short lines max.`;
}

function extractFencedCode(raw: string): string | null {
  const match = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (!match) return null;
  const code = match[1].trim();
  return code.length > 0 ? code : null;
}

function extractCodeFix(raw?: string): string | null {
  if (!raw) return null;
  const fenced = raw.match(/^```(?:\w+)?\n([\s\S]*?)```\s*$/);
  if (fenced) {
    const code = fenced[1].trim();
    return code.length > 0 ? code : null;
  }
  const code = raw.trim();
  return code.length > 0 ? code : null;
}

function getApplyFixKey(applyFix: { code: string; file: string; line?: number }): string {
  return `${applyFix.file}:${applyFix.line ?? 0}:${applyFix.code}`;
}

function getSavedModel(): string {
  const state = getVsCodeApi().getState() as { model?: string } | null;
  const saved = state?.model ?? "eco-ai";
  return AVAILABLE_MODEL_IDS.includes(saved) ? saved : "eco-ai";
}

function saveModel(model: string) {
  const state = getVsCodeApi().getState() as Record<string, unknown> | null;
  getVsCodeApi().setState({ ...(state ?? {}), model });
}

export function ChatPage({ context }: ChatPageProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [model, setModel] = useState(getSavedModel);
  const [appliedFixKeys, setAppliedFixKeys] = useState<Set<string>>(new Set());
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingMessage, setOnboardingMessage] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyErrorMsg, setApiKeyErrorMsg] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Track which context was last auto-sent so switching tabs doesn't re-trigger it,
  // but clicking "Ask AI" on a new suggestion does.
  const autoSentContextRef = useRef<SuggestionContext | null>(null);
  const contextRef = useRef<SuggestionContext | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  // Text of a message that was sent but bounced back with needsApiKey
  const pendingMessageRef = useRef<string | null>(null);
  // Whether the pending message is already in the messages list
  const pendingAddedToUI = useRef(false);

  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  // On mount: send modelChanged so the extension persists the model and checks API key
  useEffect(() => {
    postMessage({ type: "modelChanged", model });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-send when context changes to a new suggestion (e.g. "Ask AI" clicked).
  // If the onboarding card is showing (no API key yet), queue the message so it
  // retries automatically once the key is saved.
  useEffect(() => {
    if (context && context !== autoSentContextRef.current) {
      autoSentContextRef.current = context;
      const targetFile = context.targetFile ?? context.files[0];
      const targetLine = context.targetLine ? ` line ${context.targetLine}` : "";
      const locationHint = targetFile ? ` Target location: ${targetFile}${targetLine}.` : "";
      const autoText = `Analyze this ${context.type} issue and suggest a fix: ${context.description}.${locationHint} Include the proposed code in a fenced code block.`;
      if (showOnboarding) {
        // Key not entered yet ??add message to UI now, store for retry after key entry
        setMessages((prev) => [...prev, { role: "user", content: autoText }]);
        pendingMessageRef.current = isGptModel(model) ? autoText : toCodeFocusedPrompt(autoText);
        pendingAddedToUI.current = true;
      } else {
        sendChatRequest(autoText, true);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  // Listen for host messages
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as HostMessage;
      switch (msg.type) {
        case "chatStreaming":
          setStreamingContent((prev) => prev + msg.chunk);
          break;

        case "chatDone":
          setIsLoading(false);
          setStreamingContent("");
          setMessages((prev) => {
            const currentContext = contextRef.current;
            const file = currentContext?.targetFile ?? currentContext?.files[0];
            const line = currentContext?.targetLine;
            const content = msg.fullContent ?? "";
            const code =
              extractFencedCode(content) ??
              extractCodeFix(currentContext?.codeFix) ??
              content.trim();
            const applyFix = file && code ? { file, line, code } : undefined;

            return [...prev, { role: "ai", content: content, applyFix }];
          });
          pendingMessageRef.current = null;
          pendingAddedToUI.current = false;
          break;

        case "chatError":
          setIsLoading(false);
          setStreamingContent("");
          setMessages((prev) => [
            ...prev,
            { role: "ai", content: `**Error:** ${msg.message}` },
          ]);
          pendingMessageRef.current = null;
          pendingAddedToUI.current = false;
          break;

        case "needsApiKey":
          setIsLoading(false);
          setOnboardingMessage(msg.message ?? "");
          setShowOnboarding(true);
          break;

        case "apiKeyStored": {
          setShowOnboarding(false);
          setApiKeyInput("");
          setApiKeyErrorMsg("");
          setOnboardingMessage("");
          // Retry the pending message if there is one
          const pending = pendingMessageRef.current;
          if (pending) {
            pendingMessageRef.current = null;
            // Message already in UI, just send the request
            setIsLoading(true);
            postMessage({ type: "chat", text: pending, model });
          }
          break;
        }

        case "apiKeyError":
          setApiKeyErrorMsg(msg.message);
          break;

        case "apiKeyCleared":
          setShowOnboarding(true);
          setOnboardingMessage("");
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  // model is needed in the apiKeyStored handler
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, streamingContent]);

  // Close model dropdown on outside click
  useEffect(() => {
    if (!showModelDropdown) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelDropdown]);

  // Send a chat request, optionally adding the user message to the UI first
  const sendChatRequest = (text: string, addToUI = true) => {
    const textForModel = isGptModel(model) ? text : toCodeFocusedPrompt(text);
    if (addToUI) {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      pendingAddedToUI.current = true;
    }
    pendingMessageRef.current = textForModel;
    setIsLoading(true);
    postMessage({ type: "chat", text: textForModel, model });
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    sendChatRequest(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newModel = e.target.value;
    setModel(newModel);
    saveModel(newModel);
    postMessage({ type: "modelChanged", model: newModel });
    if (newModel === "eco-ai") {
      setShowOnboarding(false);
    }
  };

  const handleSubmitApiKey = () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    postMessage({ type: "setApiKey", key });
    setApiKeyInput(""); // clear immediately ??never hold key in state after sending
  };

  const handleApiKeyInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSubmitApiKey();
  };

  const handleApplyFix = (applyFix: { code: string; file: string; line?: number }) => {
    const key = getApplyFixKey(applyFix);
    setAppliedFixKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    postMessage({ type: "applyFix", ...applyFix });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Context pill */}
      {context && !showOnboarding && (
        <div
          style={{
            padding: "5px 12px",
            borderBottom: "1px solid var(--vscode-panel-border)",
            flexShrink: 0,
            color: "var(--vscode-descriptionForeground)",
            fontSize: "11px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {context.type} · {context.files[0]}
        </div>
      )}

      {showOnboarding ? (
        /* Onboarding card */
        <div className="eco-scroll-invisible" style={{ flex: 1, padding: "16px", overflowY: "auto", minHeight: 0 }}>
          <div
            style={{
              border: "1px solid var(--vscode-input-border)",
              borderRadius: "6px",
              background: "var(--vscode-input-background)",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            {onboardingMessage && (
              <p style={{ margin: 0, fontSize: "12px", color: "var(--vscode-errorForeground)" }}>
                {onboardingMessage}
              </p>
            )}
            <p style={{ margin: 0, color: "var(--vscode-foreground)", fontSize: "var(--vscode-font-size)" }}>
              Enter your OpenAI API key to enable AI chat
            </p>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={handleApiKeyInputKeyDown}
              placeholder="sk-..."
              style={{
                background: "var(--vscode-input-background)",
                color: "var(--vscode-input-foreground)",
                border: "1px solid var(--vscode-input-border)",
                borderRadius: "3px",
                padding: "6px 8px",
                fontSize: "var(--vscode-font-size)",
                width: "100%",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
            {apiKeyErrorMsg && (
              <p style={{ margin: 0, fontSize: "12px", color: "var(--vscode-errorForeground)" }}>
                {apiKeyErrorMsg}
              </p>
            )}
            <button
              onClick={handleSubmitApiKey}
              style={{
                background: "var(--vscode-button-background)",
                color: "var(--vscode-button-foreground)",
                border: "none",
                borderRadius: "3px",
                padding: "6px 14px",
                fontSize: "var(--vscode-font-size)",
                cursor: "pointer",
                alignSelf: "flex-start",
              }}
            >
              Save Key
            </button>
            <p style={{ margin: 0, fontSize: "11px", color: "var(--vscode-descriptionForeground)" }}>
              Your key is stored securely in your system keychain and never sent to our servers.
            </p>
          </div>
        </div>
      ) : (
        /* Messages */
        <div
          className="eco-scroll-invisible"
          style={{
            flex: 1,
            overflowY: "auto",
            minHeight: 0,
            padding: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <span
                style={{
                  fontSize: "10px",
                  color: "var(--vscode-descriptionForeground)",
                  marginBottom: "4px",
                }}
              >
                {msg.role === "user" ? "you" : "eco"}
              </span>

              {msg.role === "user" ? (
                <div
                  style={{
                    background: "#2e7d32",
                    color: "#ffffff",
                    padding: "8px 12px",
                    borderRadius: "12px 12px 0 12px",
                    maxWidth: "85%",
                    fontSize: "var(--vscode-font-size)",
                    lineHeight: 1.5,
                    wordBreak: "break-word",
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                <div style={{ maxWidth: "100%", width: "100%" }}>
                  <Markdown content={msg.content} addCopyButtons />
                  {msg.applyFix
                    ? (() => {
                        const applyFix = msg.applyFix;
                        const applied = appliedFixKeys.has(getApplyFixKey(applyFix));
                        return (
                          <button
                            className="eco-btn-primary"
                            onClick={() => handleApplyFix(applyFix)}
                            disabled={applied}
                            title="Apply this fix in code"
                            style={{
                              marginTop: "8px",
                              gap: "5px",
                              display: "flex",
                              alignItems: "center",
                              color: "var(--vscode-button-foreground)",
                              fontSize: "11px",
                              padding: "4px 10px",
                              background: "var(--vscode-button-background)",
                              border: "1px solid var(--vscode-button-border, transparent)",
                              borderRadius: "4px",
                              opacity: applied ? 0.6 : 1,
                              cursor: applied ? "default" : "pointer",
                            }}
                          >
                            {applied ? "Applied" : "Apply Fix"}
                          </button>
                        );
                      })()
                    : null}
                </div>
              )}
            </div>
          ))}

          {/* Streaming / loading indicator */}
          {isLoading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", maxWidth: "100%", width: "100%" }}>
              <span
                style={{
                  fontSize: "10px",
                  color: "var(--vscode-descriptionForeground)",
                  marginBottom: "4px",
                }}
              >
                eco
              </span>
              {streamingContent ? (
                <div style={{ maxWidth: "100%", width: "100%" }}>
                  <Markdown content={streamingContent} />
                </div>
              ) : (
                <div className="eco-thinking" aria-live="polite">
                  Thinking
                  <span className="eco-thinking-dots">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                  </span>
                </div>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input box — hidden while onboarding */}
      {!showOnboarding && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--vscode-panel-border)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "flex-end",
              gap: "4px",
              background: "var(--vscode-input-background)",
              border: "1.5px solid #4caf50",
              borderRadius: "10px",
              padding: "6px 6px 6px 10px",
              opacity: isLoading ? 0.6 : 1,
              position: "relative",
            }}
          >
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask a follow-up..."
              disabled={isLoading}
              rows={1}
              style={{
                flex: 1,
                background: "transparent",
                color: "var(--vscode-input-foreground)",
                border: "none",
                outline: "none",
                resize: "none",
                fontFamily: "var(--vscode-font-family)",
                fontSize: "var(--vscode-font-size)",
                lineHeight: 1.5,
                minHeight: "22px",
                padding: 0,
              }}
            />

            {/* Model selector */}
            <div ref={modelDropdownRef} style={{ position: "relative", flexShrink: 0 }}>
              <button
                className="eco-chat-icon-btn"
                onClick={() => !isLoading && setShowModelDropdown((v) => !v)}
                title="Select model"
                style={{
                  background: showModelDropdown ? "rgba(76,175,80,0.25)" : "transparent",
                  cursor: isLoading ? "not-allowed" : "pointer",
                  opacity: isLoading ? 0.4 : 1,
                  color: "#ffffff",
                }}
                onMouseEnter={(e) => { if (!isLoading) (e.currentTarget as HTMLButtonElement).style.background = "rgba(76,175,80,0.25)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = showModelDropdown ? "rgba(76,175,80,0.25)" : "transparent"; }}
              >
                {/* Robot/model icon */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 1a1.5 1.5 0 0 1 1.5 1.5V3h2A1.5 1.5 0 0 1 13 4.5v7A1.5 1.5 0 0 1 11.5 13h-7A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3h2v-.5A1.5 1.5 0 0 1 8 1zm0 1a.5.5 0 0 0-.5.5V3h1v-.5A.5.5 0 0 0 8 2zM5.75 7a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm4.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM6 10.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H6z"/>
                </svg>
                {/* Chevron */}
                <svg
                  width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: showModelDropdown ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}
                >
                  <polyline points="3,11 8,5 13,11" />
                </svg>
              </button>

              {showModelDropdown && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "calc(100% + 8px)",
                    right: 0,
                    background: "var(--vscode-dropdown-background, var(--vscode-editor-background))",
                    border: "1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))",
                    borderRadius: "8px",
                    boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
                    minWidth: "160px",
                    zIndex: 100,
                    overflow: "hidden",
                    padding: "4px 0",
                  }}
                >
                  {MODEL_GROUPS.map((group, gi) => (
                    <div key={group.label}>
                      {gi > 0 && (
                        <div style={{ height: "1px", background: "var(--vscode-panel-border)", margin: "3px 0" }} />
                      )}
                      <div
                        style={{
                          padding: "4px 10px 2px",
                          fontSize: "10px",
                          fontWeight: 600,
                          color: "var(--vscode-descriptionForeground)",
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                        }}
                      >
                        {group.label}
                      </div>
                      {group.models.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => {
                            handleModelChange({ target: { value: m.id } } as React.ChangeEvent<HTMLSelectElement>);
                            setShowModelDropdown(false);
                          }}
                          onMouseEnter={(e) => {
                            if (model !== m.id) {
                              (e.currentTarget as HTMLButtonElement).style.background = "var(--vscode-list-hoverBackground)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (model !== m.id) {
                              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                            }
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            width: "100%",
                            padding: "5px 10px",
                            background: model === m.id ? "rgba(0,0,0,0.25)" : "transparent",
                            color: "var(--vscode-foreground)",
                            border: "none",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontFamily: "var(--vscode-font-family)",
                            textAlign: "left",
                            transition: "background 120ms ease",
                          }}
                        >
                          {model === m.id
                            ? <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="2,9 6,13 14,3" /></svg>
                            : <span style={{ display: "inline-block", width: "11px", flexShrink: 0 }} />
                          }
                          <span>{m.name}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Send button — no disabled attr to avoid VSCode webview CSS hiding it */}
            <button
              className="eco-chat-icon-btn"
              onClick={handleSend}
              title="Send (Enter)"
              style={{
                flexShrink: 0,
                background: "#4caf50",
                cursor: isLoading || !input.trim() ? "default" : "pointer",
                opacity: isLoading || !input.trim() ? 0.45 : 1,
                color: "#ffffff",
              }}
            >
              {/* Arrow with stem */}
              <svg width="14" height="14" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
                <polygon points="1,5 7,5 7,2 11,6 7,10 7,7 1,7" fill="#ffffff" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

