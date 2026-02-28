export interface HttpCallMatch {
  method: string;
  url: string;
  library: string;
}

interface PatternDef {
  library: string;
  regex: RegExp;
  methodGroup: number | null; // capture group index for method, null if default GET
  urlGroup: number; // capture group index for URL
}

// Each pattern extracts HTTP method + URL from a line of code
const PATTERN_DEFS: PatternDef[] = [
  // fetch("url", { method: "POST" })
  {
    library: "fetch",
    regex: /fetch\(\s*['"`](https?:\/\/[^'"`\s]+)['"`]\s*,\s*\{[^}]*method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gi,
    urlGroup: 1,
    methodGroup: 2,
  },
  // fetch("url") — defaults to GET
  {
    library: "fetch",
    regex: /fetch\(\s*['"`](https?:\/\/[^'"`\s]+)['"`]/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  // fetch(`${base}/path`) — template literal
  {
    library: "fetch",
    regex: /fetch\(\s*`([^`]+)`/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  // axios.get("url"), axios.post("url"), etc.
  {
    library: "axios",
    regex: /axios\.(get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // axios("url") — defaults to GET
  {
    library: "axios",
    regex: /axios\(\s*['"`](https?:\/\/[^'"`\s]+)['"`]/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  // got.get("url"), got.post("url"), etc.
  {
    library: "got",
    regex: /got\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // got("url") — defaults to GET
  {
    library: "got",
    regex: /got\(\s*['"`]([^'"`\s]+)['"`]/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  // superagent.get("url"), superagent.post("url")
  {
    library: "superagent",
    regex: /superagent\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // ky.get("url"), ky.post("url")
  {
    library: "ky",
    regex: /ky\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // Python requests.get("url"), requests.post("url")
  {
    library: "requests",
    regex: /requests\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // Go http.Get("url"), http.Post("url")
  {
    library: "http",
    regex: /http\.(Get|Post|Head)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // Angular HttpClient: this.http.get<T>("url")
  {
    library: "HttpClient",
    regex: /(?:this\.)?http\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  // $http.get("url") — AngularJS
  {
    library: "$http",
    regex: /\$http\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
];

const LOOP_KEYWORDS = /\b(for|while|forEach|\.map|\.flatMap|\.reduce)\b/;

export function matchLine(line: string): HttpCallMatch[] {
  const matches: HttpCallMatch[] = [];
  const seen = new Set<string>();

  for (const def of PATTERN_DEFS) {
    // Reset regex lastIndex since they're global
    def.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = def.regex.exec(line)) !== null) {
      const method = def.methodGroup !== null
        ? match[def.methodGroup].toUpperCase()
        : "GET";
      const url = match[def.urlGroup];
      const key = `${method} ${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ method, url, library: def.library });
      }
    }
  }

  return matches;
}

export function isInsideLoop(lines: string[], currentIndex: number): boolean {
  const lookback = Math.max(0, currentIndex - 5);
  for (let i = lookback; i < currentIndex; i++) {
    if (LOOP_KEYWORDS.test(lines[i])) {
      return true;
    }
  }
  return false;
}
