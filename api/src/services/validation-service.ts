import { ApiCallInput, ProjectInput, ProjectPatchInput, ScanInput } from "../models/types";
import { AppError } from "../utils/app-error";

interface FieldError {
  field: string;
  message: string;
}

const ensureObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a JSON object`, 422, {
      fields: [{ field: name, message: "Must be an object." }]
    });
  }
  return value as Record<string, unknown>;
};

const validateApiCall = (value: unknown, index: number): ApiCallInput => {
  const call = ensureObject(value, `apiCalls[${index}]`);
  const fieldErrors: FieldError[] = [];

  const file = call.file;
  const line = call.line;
  const method = call.method;
  const url = call.url;
  const library = call.library;
  const frequency = call.frequency;

  if (typeof file !== "string" || file.trim() === "") {
    fieldErrors.push({ field: `apiCalls[${index}].file`, message: "file is required." });
  }
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    fieldErrors.push({
      field: `apiCalls[${index}].line`,
      message: "line must be an integer >= 1."
    });
  }
  if (typeof method !== "string" || method.trim() === "") {
    fieldErrors.push({ field: `apiCalls[${index}].method`, message: "method is required." });
  }
  if (typeof url !== "string" || url.trim() === "") {
    fieldErrors.push({ field: `apiCalls[${index}].url`, message: "url is required." });
  }
  if (typeof library !== "string" || library.trim() === "") {
    fieldErrors.push({
      field: `apiCalls[${index}].library`,
      message: "library is required."
    });
  }
  if (frequency !== undefined && typeof frequency !== "string") {
    fieldErrors.push({
      field: `apiCalls[${index}].frequency`,
      message: "frequency must be a string when provided."
    });
  }

  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Invalid apiCalls payload", 422, {
      fields: fieldErrors
    });
  }

  return {
    file: file as string,
    line: line as number,
    method: (method as string).toUpperCase(),
    url: url as string,
    library: library as string,
    frequency: frequency as string | undefined
  };
};

export const validateCreateProjectInput = (body: unknown): ProjectInput => {
  const input = ensureObject(body, "body");
  const fieldErrors: FieldError[] = [];

  if (typeof input.name !== "string" || input.name.trim() === "") {
    fieldErrors.push({ field: "name", message: "name is required and must be a string." });
  }

  if (input.description !== undefined && typeof input.description !== "string") {
    fieldErrors.push({ field: "description", message: "description must be a string." });
  }

  let apiCalls: ApiCallInput[] | undefined;
  if (input.apiCalls !== undefined) {
    if (!Array.isArray(input.apiCalls)) {
      fieldErrors.push({ field: "apiCalls", message: "apiCalls must be an array." });
    } else if (input.apiCalls.length > MAX_API_CALLS) {
      fieldErrors.push({ field: "apiCalls", message: `Must contain ${MAX_API_CALLS} or fewer items.` });
    } else {
      apiCalls = input.apiCalls.map((call, index) => validateApiCall(call, index));
    }
  }

  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Invalid project payload", 422, {
      fields: fieldErrors
    });
  }

  return {
    name: (input.name as string).trim(),
    description: input.description as string | undefined,
    apiCalls
  };
};

export const validatePatchProjectInput = (body: unknown): ProjectPatchInput => {
  const input = ensureObject(body, "body");
  const fieldErrors: FieldError[] = [];

  if (input.name === undefined && input.description === undefined) {
    fieldErrors.push({
      field: "body",
      message: "At least one of 'name' or 'description' must be provided."
    });
  }

  if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim() === "")) {
    fieldErrors.push({ field: "name", message: "name must be a non-empty string." });
  }

  if (input.description !== undefined && typeof input.description !== "string") {
    fieldErrors.push({ field: "description", message: "description must be a string." });
  }

  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Invalid project update payload", 422, {
      fields: fieldErrors
    });
  }

  return {
    ...(input.name !== undefined ? { name: (input.name as string).trim() } : {}),
    ...(input.description !== undefined ? { description: input.description as string } : {})
  };
};

const MAX_API_CALLS = 2000;

export const validateScanInput = (body: unknown): ScanInput => {
  const input = ensureObject(body, "body");
  if (!Array.isArray(input.apiCalls)) {
    throw new AppError("VALIDATION_ERROR", "Invalid scan payload", 422, {
      fields: [{ field: "apiCalls", message: "apiCalls is required and must be an array." }]
    });
  }
  if (input.apiCalls.length > MAX_API_CALLS) {
    throw new AppError("VALIDATION_ERROR", `apiCalls exceeds maximum allowed size of ${MAX_API_CALLS}`, 422, {
      fields: [{ field: "apiCalls", message: `Must contain ${MAX_API_CALLS} or fewer items.` }]
    });
  }

  return {
    apiCalls: input.apiCalls.map((call, index) => validateApiCall(call, index))
  };
};

