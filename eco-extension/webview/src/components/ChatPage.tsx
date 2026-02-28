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
}

function getSavedModel(): string {
  const state = getVsCodeApi().getState() as { model?: string } | null;
  return state?.model ?? "gpt-4o-mini";
}

function saveModel(model: string) {
  const state = getVsCodeApi().getState() as Record<string, unknown> | null;
  getVsCodeApi().setState({ ...(state ?? {}), model });
}

export function ChatPage({ context }: ChatPageProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState(getSavedModel);

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingMessage, setOnboardingMessage] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyErrorMsg, setApiKeyErrorMsg] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Track which context was last auto-sent so switching tabs doesn't re-trigger it,
  // but clicking "Ask AI" on a new suggestion does.
  const autoSentContextRef = useRef<SuggestionContext | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Text of a message that was sent but bounced back with needsApiKey
  const pendingMessageRef = useRef<string | null>(null);
  // Whether the pending message is already in the messages list
  const pendingAddedToUI = useRef(false);

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
      const autoText = `Analyze this ${context.type} issue and suggest a fix: ${context.description}`;
      if (showOnboarding) {
        // Key not entered yet — add message to UI now, store for retry after key entry
        setMessages((prev) => [...prev, { role: "user", content: autoText }]);
        pendingMessageRef.current = autoText;
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
        case "chatResponse":
          setIsLoading(false);
          setMessages((prev) => [...prev, { role: "ai", content: msg.text }]);
          pendingMessageRef.current = null;
          pendingAddedToUI.current = false;
          break;

        case "chatError":
          setIsLoading(false);
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
  }, [messages, isLoading]);

  // Send a chat request, optionally adding the user message to the UI first
  const sendChatRequest = (text: string, addToUI = true) => {
    if (addToUI) {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      pendingAddedToUI.current = true;
    }
    pendingMessageRef.current = text;
    setIsLoading(true);
    postMessage({ type: "chat", text, model });
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
  };

  const handleSubmitApiKey = () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    postMessage({ type: "setApiKey", key });
    setApiKeyInput(""); // clear immediately — never hold key in state after sending
  };

  const handleApiKeyInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSubmitApiKey();
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
          <span className="codicon codicon-tag" style={{ fontSize: "11px", marginRight: "4px" }} />
          {context.type} · {context.files[0]}
        </div>
      )}

      {showOnboarding ? (
        /* Onboarding card */
        <div style={{ flex: 1, padding: "16px", overflowY: "auto" }}>
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
          style={{
            flex: 1,
            overflowY: "auto",
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
                </div>
              )}
            </div>
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <span
                style={{
                  fontSize: "10px",
                  color: "var(--vscode-descriptionForeground)",
                  marginBottom: "4px",
                }}
              >
                eco
              </span>
              <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "var(--vscode-font-size)" }}>
                …
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input row — hidden while onboarding */}
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
            placeholder="Ask a follow-up…"
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
              border: "1px solid var(--vscode-dropdown-border)",
              borderRadius: "3px",
              padding: "0 4px",
              height: "28px",
              fontSize: "11px",
              flexShrink: 0,
              cursor: isLoading ? "not-allowed" : "pointer",
              opacity: isLoading ? 0.5 : 1,
            }}
          >
            <option value="gpt-4o-mini">GPT-4o Mini</option>
            <option value="gpt-4o">GPT-4o</option>
          </select>
          <button
            className="eco-btn-icon"
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            title="Send"
            style={{
              flexShrink: 0,
              width: "28px",
              height: "28px",
              opacity: input.trim() && !isLoading ? 1 : 0.35,
              color: "var(--vscode-foreground)",
            }}
          >
            <span className="codicon codicon-send" style={{ fontSize: "14px" }} />
          </button>
        </div>
      )}
    </div>
  );
}
