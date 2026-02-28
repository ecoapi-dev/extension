import * as vscode from "vscode";
import { ApiCallInput } from "../analysis/types";
import { matchLine, isInsideLoop } from "./patterns";

const MAX_FILES = 500;

export interface ScanProgress {
  file: string;
  index: number;
  total: number;
  endpointsSoFar: number;
}

export async function scanWorkspace(
  onProgress?: (progress: ScanProgress) => void
): Promise<ApiCallInput[]> {
  const config = vscode.workspace.getConfiguration("eco");
  const includeGlob = config.get<string>("scanGlob", "**/*.{ts,tsx,js,jsx,py,go,java,rb}");
  const excludeGlob = config.get<string>(
    "excludeGlob",
    "**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/.next/**,**/vendor/**"
  );

  const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob, MAX_FILES);
  const allCalls: ApiCallInput[] = [];

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    const relativePath = vscode.workspace.asRelativePath(uri, false);

    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(content).toString("utf-8");
      const lines = text.split("\n");

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const matches = matchLine(line);

        for (const match of matches) {
          const inLoop = isInsideLoop(lines, lineIndex);
          const snippetStart = Math.max(0, lineIndex - 2);
          const snippetEnd = Math.min(lines.length - 1, lineIndex + 2);
          const codeSnippet = lines.slice(snippetStart, snippetEnd + 1).join("\n");
          allCalls.push({
            file: relativePath,
            line: lineIndex + 1,
            method: match.method,
            url: match.url,
            library: match.library,
            frequency: inLoop ? "per-request" : "daily",
            codeSnippet,
          });
        }
      }
    } catch {
      // Skip files that can't be read
    }

    onProgress?.({
      file: relativePath,
      index: i,
      total: uris.length,
      endpointsSoFar: allCalls.length,
    });
  }

  return allCalls;
}
