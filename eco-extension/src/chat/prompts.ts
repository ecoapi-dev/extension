import type { SuggestionContext } from "../messages";

export function buildSystemPrompt(
  context: SuggestionContext | null,
  fileContents: Map<string, string>
): string {
  let prompt = `You are ECO, an API usage optimization assistant integrated into a VS Code extension. You help developers fix inefficient API call patterns in their code.

Your responses should be:
- Concise and practical
- Focused on the specific optimization
- Include code examples wrapped in \`\`\`language blocks when suggesting fixes
- Use the actual code from the user's files when available`;

  if (context) {
    prompt += `

## Current Context
- Issue type: ${context.type}
- Severity: ${context.severity ?? "unknown"}
- Description: ${context.description}
- Affected files: ${context.files.join(", ")}`;

    if (context.codeFix) {
      prompt += `\n- Suggested approach: ${context.codeFix}`;
    }

    if (context.estimatedMonthlySavings) {
      prompt += `\n- Estimated monthly savings: $${context.estimatedMonthlySavings.toFixed(2)}`;
    }
  }

  if (fileContents.size > 0) {
    prompt += "\n\n## Relevant Source Files\n";
    for (const [file, content] of fileContents.entries()) {
      // Truncate large files to keep context manageable
      const truncated = content.length > 3000
        ? content.slice(0, 3000) + "\n... (truncated)"
        : content;
      prompt += `\n--- ${file} ---\n${truncated}\n`;
    }
  }

  return prompt;
}
