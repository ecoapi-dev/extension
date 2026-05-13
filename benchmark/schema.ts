import * as fs from "node:fs";

export interface ExpectedEndpoint {
  /** Path relative to the fixture root (e.g. "src/openai-helper.ts"). NOT the repo root. */
  file: string;
  /** Optional — enclosing function name. Not consumed by metrics; for human readability. */
  function?: string;
  /** 1-based line number where the call appears. */
  line: number;
  /** Canonical provider id, matching src/intelligence/provider-normalization.ts. */
  provider: string;
  /** SDK method signature OR URL-path key. */
  method: string;
  /** Always true. Present so the JSON file is self-documenting and to allow future "may_detect" loosening. */
  must_detect: true;
  notes?: string;
}

export interface ExpectedFinding {
  file: string;
  function?: string;
  line: number;
  /** Finding type — e.g. "n_plus_one", "unbounded_loop", "missing_cache_guard", "polling_no_backoff". */
  type: string;
  is_true_positive: true;
  notes?: string;
}

export interface ExpectedJson {
  schemaVersion: 1;
  fixtureSlug: string;
  endpoints: ExpectedEndpoint[];
  findings: ExpectedFinding[];
}

export class ExpectedJsonValidationError extends Error {
  constructor(public readonly fixturePath: string, message: string) {
    super(`${fixturePath}: ${message}`);
    this.name = "ExpectedJsonValidationError";
  }
}

/**
 * Load and validate an expected.json file. Throws ExpectedJsonValidationError on any schema issue.
 */
export function loadExpectedJson(absolutePath: string): ExpectedJson {
  const raw = fs.readFileSync(absolutePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExpectedJsonValidationError(absolutePath, `invalid JSON: ${(err as Error).message}`);
  }
  return validateExpectedJson(parsed, absolutePath);
}

export function validateExpectedJson(value: unknown, fixturePath: string): ExpectedJson {
  if (!value || typeof value !== "object") {
    throw new ExpectedJsonValidationError(fixturePath, "expected JSON object at top level");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new ExpectedJsonValidationError(fixturePath, `schemaVersion must be 1, got ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (typeof obj.fixtureSlug !== "string" || obj.fixtureSlug.length === 0) {
    throw new ExpectedJsonValidationError(fixturePath, "fixtureSlug must be a non-empty string");
  }
  if (!Array.isArray(obj.endpoints)) {
    throw new ExpectedJsonValidationError(fixturePath, "endpoints must be an array");
  }
  if (!Array.isArray(obj.findings)) {
    throw new ExpectedJsonValidationError(fixturePath, "findings must be an array");
  }
  const endpoints = obj.endpoints.map((e, i) => validateEndpoint(e, fixturePath, i));
  const findings = obj.findings.map((f, i) => validateFinding(f, fixturePath, i));
  return { schemaVersion: 1, fixtureSlug: obj.fixtureSlug, endpoints, findings };
}

function validateEndpoint(value: unknown, fixturePath: string, index: number): ExpectedEndpoint {
  if (!value || typeof value !== "object") {
    throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}] must be an object`);
  }
  const e = value as Record<string, unknown>;
  if (typeof e.file !== "string") throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].file must be a string`);
  if (typeof e.line !== "number" || !Number.isInteger(e.line) || e.line < 1) {
    throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].line must be a 1-based integer`);
  }
  if (typeof e.provider !== "string") throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].provider must be a string`);
  if (typeof e.method !== "string") throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].method must be a string`);
  if (e.must_detect !== true) throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].must_detect must be true`);
  return {
    file: e.file,
    line: e.line,
    provider: e.provider,
    method: e.method,
    must_detect: true,
    function: typeof e.function === "string" ? e.function : undefined,
    notes: typeof e.notes === "string" ? e.notes : undefined,
  };
}

function validateFinding(value: unknown, fixturePath: string, index: number): ExpectedFinding {
  if (!value || typeof value !== "object") {
    throw new ExpectedJsonValidationError(fixturePath, `findings[${index}] must be an object`);
  }
  const f = value as Record<string, unknown>;
  if (typeof f.file !== "string") throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].file must be a string`);
  if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1) {
    throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].line must be a 1-based integer`);
  }
  if (typeof f.type !== "string") throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].type must be a string`);
  if (f.is_true_positive !== true) throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].is_true_positive must be true`);
  return {
    file: f.file,
    line: f.line,
    type: f.type,
    is_true_positive: true,
    function: typeof f.function === "string" ? f.function : undefined,
    notes: typeof f.notes === "string" ? f.notes : undefined,
  };
}
