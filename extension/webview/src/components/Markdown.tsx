import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface MarkdownProps {
  content: string;
  addCopyButtons?: boolean;
  className?: string;
}

export function Markdown({ content, addCopyButtons = false, className = "" }: MarkdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const html = marked.parse(content) as string;
    ref.current.innerHTML = DOMPurify.sanitize(html);

    if (addCopyButtons) {
      ref.current.querySelectorAll("pre").forEach((pre) => {
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";

        const btn = document.createElement("button");
        btn.className = "eco-code-copy codicon codicon-copy";
        btn.title = "Copy";
        btn.onclick = () => {
          navigator.clipboard.writeText(code);
          btn.className = "eco-code-copy codicon codicon-check";
          setTimeout(() => {
            btn.className = "eco-code-copy codicon codicon-copy";
          }, 2000);
        };

        pre.appendChild(btn);
      });
    }
  }, [content, addCopyButtons]);

  return <div ref={ref} className={`eco-md ${className}`} />;
}
