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
                    background: "var(--vscode-button-background)",
                    color: "var(--vscode-button-foreground)",
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
                isGptModel(model) ? (
                  <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "var(--vscode-font-size)" }}>
                    ...
                  </span>
                ) : (
                  <div className="eco-thinking" aria-live="polite">
                    Thinking
                    <span className="eco-thinking-dots">
                      <span>.</span>
                      <span>.</span>
                      <span>.</span>
                    </span>
                  </div>
                )
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input row ??hidden while onboarding */}
      {!showOnboarding && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--vscode-panel-border)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <textarea
            ref={textareaRef}
            className="eco-input"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask a follow-up..."
            disabled={isLoading}
            rows={1}
            style={{
              flex: 1,
              opacity: isLoading ? 0.5 : 1,
              lineHeight: 1.5,
              minHeight: "28px",
              padding: "4px 8px",
            }}
          />
          <select
            value={model}
            onChange={handleModelChange}
            disabled={isLoading}
            title="Select model"
            style={{
              background: "var(--vscode-dropdown-background)",
              color: "var(--vscode-dropdown-foreground)",
              border: "1px solid var(--vscode-dropdown-border, var(--vscode-input-border))",
              borderRadius: "3px",
              padding: "0 6px",
              height: "28px",
              fontSize: "11px",
              fontFamily: "var(--vscode-font-family)",
              flexShrink: 0,
              cursor: isLoading ? "not-allowed" : "pointer",
              opacity: isLoading ? 0.5 : 1,
              outline: "none",
              maxWidth: "120px",
            }}
          >
            {MODEL_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            title="Send"
            style={{
              flexShrink: 0,
              minWidth: "62px",
              height: "28px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "5px",
              background: "var(--vscode-button-background)",
              border: "1px solid var(--vscode-button-border, transparent)",
              borderRadius: "3px",
              cursor: isLoading || !input.trim() ? "default" : "pointer",
              padding: "4px 10px",
              color: "var(--vscode-button-foreground)",
              opacity: input.trim() && !isLoading ? 1 : 0.45,
            }}
          >
            <span style={{ fontSize: "11px" }}>Send</span>
          </button>
        </div>
      )}
    </div>
  );
}

