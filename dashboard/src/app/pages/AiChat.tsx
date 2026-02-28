import React, { useState, useRef, useEffect } from 'react';
import { Send, Copy, Check, Play, Sparkles, Leaf, MessageSquare, ChevronRight } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
  codeBlocks?: { language: string; code: string }[];
}

const initialMessages: Message[] = [
  {
    id: '1',
    role: 'ai',
    content: "I've analyzed the suggestion for caching the OpenAI /v1/models endpoint. Here's what I recommend:",
    codeBlocks: [
      {
        language: 'typescript',
        code: `// src/ai/utils.ts - Add response caching
import { createCache } from '../lib/cache';

const modelsCache = createCache<ModelList>({
  ttl: 24 * 60 * 60 * 1000, // 24 hours
  key: 'openai-models',
});

export async function getModels() {
  const cached = modelsCache.get();
  if (cached) return cached;

  const response = await openai.models.list();
  modelsCache.set(response);
  return response;
}`,
      },
    ],
  },
  {
    id: '2',
    role: 'user',
    content: 'Should I add cache invalidation too?',
  },
  {
    id: '3',
    role: 'ai',
    content: "Good thinking! Since the models list changes very rarely, a simple TTL-based expiration is sufficient. However, here's a manual invalidation helper if you ever need it:",
    codeBlocks: [
      {
        language: 'typescript',
        code: `// Add to src/lib/cache.ts
export function invalidateCache(key: string) {
  cacheStore.delete(key);
  console.log(\`[eco] Cache invalidated: \${key}\`);
}

// Usage anywhere:
invalidateCache('openai-models');`,
      },
    ],
  },
];

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-[#243224]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0B0F0B]">
        <span className="text-[9px] text-[#7EA87E] uppercase tracking-wider">{language}</span>
        <div className="flex gap-1">
          <button
            onClick={handleCopy}
            className="px-2 py-0.5 text-[9px] text-[#7EA87E] hover:text-[#D6EDD0] bg-[#131A13] rounded border border-[#243224] hover:border-[#4EAA57]/30 transition-colors flex items-center gap-1"
          >
            {copied ? <Check size={9} /> : <Copy size={9} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="px-2 py-0.5 text-[9px] text-[#4EAA57] bg-[#4EAA57]/10 rounded border border-[#4EAA57]/20 hover:bg-[#4EAA57]/20 transition-colors flex items-center gap-1">
            <Play size={9} />
            Apply
          </button>
        </div>
      </div>
      <pre className="p-3 bg-[#080B08] overflow-x-auto">
        <code className="text-[11px] text-[#D6EDD0]/80 leading-relaxed whitespace-pre" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{code}</code>
      </pre>
    </div>
  );
}

export default function AiChat() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    setTimeout(() => {
      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: "That's a great question! Based on the current API usage patterns in your project, I'd recommend implementing a circuit breaker pattern alongside the caching strategy. This would protect against cascading failures when the OpenAI API is unavailable.",
      };
      setMessages((prev) => [...prev, aiMsg]);
      setIsTyping(false);
    }, 1500);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-[#243224]">
        <h1 className="text-[16px] text-[#D6EDD0] flex items-center gap-2">
          <Sparkles size={16} className="text-[#4EAA57]" />
          Eco AI Assistant
        </h1>
      </div>

      {/* Context Banner */}
      <div className="mx-4 mt-3 px-3 py-2 bg-[#1C271C] border border-[#4EAA57]/20 rounded-lg flex items-center gap-2">
        <Leaf size={12} className="text-[#4EAA57] shrink-0" />
        <span className="text-[10px] text-[#7EA87E] flex-1">
          Context loaded: <span className="text-[#D6EDD0]">Cache /v1/models response</span> — Redundant Call in src/ai/utils.ts
        </span>
        <ChevronRight size={12} className="text-[#7EA87E]" />
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] ${msg.role === 'user' ? '' : ''}`}>
              {msg.role === 'ai' && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <div className="w-5 h-5 rounded-md bg-[#4EAA57]/15 flex items-center justify-center">
                    <Leaf size={10} className="text-[#4EAA57]" />
                  </div>
                  <span className="text-[9px] text-[#7EA87E] uppercase tracking-wider">Eco AI</span>
                </div>
              )}
              <div className={`rounded-xl px-3.5 py-2.5 ${msg.role === 'user'
                ? 'bg-[#4EAA57]/15 border border-[#4EAA57]/20 text-[#D6EDD0]'
                : 'bg-[#131A13] border border-[#243224] text-[#D6EDD0]'
                }`}>
                <p className="text-[12px] leading-relaxed">{msg.content}</p>
                {msg.codeBlocks?.map((block, i) => (
                  <CodeBlock key={i} language={block.language} code={block.code} />
                ))}
              </div>
            </div>
          </div>
        ))}
        {isTyping && (
          <div className="flex justify-start">
            <div className="bg-[#131A13] border border-[#243224] rounded-xl px-4 py-3">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-[#4EAA57] animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-[#4EAA57] animate-pulse" style={{ animationDelay: '200ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-[#4EAA57] animate-pulse" style={{ animationDelay: '400ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto">
        {['Explain this suggestion', 'Show me the fix', 'What are the risks?', 'Estimate savings'].map((q) => (
          <button
            key={q}
            onClick={() => setInput(q)}
            className="px-2.5 py-1 text-[10px] text-[#7EA87E] bg-[#131A13] border border-[#243224] rounded-full hover:border-[#4EAA57]/30 hover:text-[#D6EDD0] transition-colors whitespace-nowrap shrink-0"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="p-4 pt-2 border-t border-[#243224]">
        <div className="flex gap-2 items-center">
          <div className="flex-1 relative">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Ask about API optimizations..."
              className="w-full bg-[#131A13] border border-[#243224] rounded-lg px-3.5 py-2.5 text-[12px] text-[#D6EDD0] placeholder:text-[#7EA87E]/40 focus:outline-none focus:border-[#4EAA57]/40 transition-colors"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="w-9 h-9 rounded-lg bg-[#4EAA57]/15 border border-[#4EAA57]/20 flex items-center justify-center text-[#4EAA57] hover:bg-[#4EAA57]/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
