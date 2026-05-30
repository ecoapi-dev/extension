import assert from "node:assert/strict";
import type { AstCallMatch } from "../ast/ast-scanner";
import { detectPythonWaste } from "../scanner/python-waste-detector";
import type { LocalWasteFinding } from "../scanner/local-waste-detector";
import { pointSpan } from "../scanner/source-span";

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

function makeMatch(overrides: Partial<AstCallMatch>): AstCallMatch {
  const line = overrides.line ?? 1;
  const column = overrides.column ?? 0;
  return {
    kind: "sdk",
    provider: "openai",
    packageName: "openai",
    methodChain: "client.chat.completions.create",
    confidence: 1,
    line,
    column,
    span: pointSpan(line, column),
    frequency: "single",
    loopContext: false,
    enclosingFunction: null,
    ...overrides,
  };
}

(async () => {
  await run("python waste: stdlib calls do not produce findings", async () => {
    const source = `
import glob
import warnings
import logging

files = glob.glob("*.py")
warnings.warn("careful")
logging.info(files)
`;

    const findings = detectPythonWaste(
      [
        makeMatch({ provider: "glob", packageName: "glob", methodChain: "glob.glob", line: 5 }),
        makeMatch({ provider: "warnings", packageName: "warnings", methodChain: "warnings.warn", line: 6 }),
        makeMatch({ provider: "logging", packageName: "logging", methodChain: "logging.info", line: 7 }),
      ],
      source,
      "/project/src/example.py"
    );
    assert.equal(findings.length, 0);
  });

  await run("python waste: langchain loop creates high n_plus_one finding", async () => {
    const source = `
from langchain.chains import LLMChain

chain = LLMChain()
prompts = ["a", "b", "c"]
for prompt in prompts:
    chain.run(prompt)
`;

    const findings = detectPythonWaste(
      [
        makeMatch({
          provider: "langchain",
          packageName: "langchain",
          methodChain: "chain.run",
          line: 6,
          frequency: "bounded-loop",
          loopContext: true,
        }),
      ],
      source,
      "/project/src/example.py"
    );
    const finding = findings.find((item) => item.type === "n_plus_one");
    assert.ok(finding, "expected N+1 finding");
    assert.equal(finding!.severity, "high");
  });

  await run("python waste: sequential openai calls create a batch finding", async () => {
    const source = `
from openai import OpenAI

client = OpenAI()
first = client.chat.completions.create(model="gpt-4o-mini", messages=[])
second = client.chat.completions.create(model="gpt-4o-mini", messages=[])
third = client.chat.completions.create(model="gpt-4o-mini", messages=[])
`;

    const findings = detectPythonWaste(
      [
        makeMatch({ line: 4 }),
        makeMatch({ line: 5 }),
        makeMatch({ line: 6 }),
      ],
      source,
      "/project/src/example.py"
    );
    const finding = findings.find((item) => item.type === "batch");
    assert.ok(finding, "expected batch finding");
    assert.equal(finding!.severity, "medium");
  });

  await run("python waste: asyncio.gather with unpacked tasks creates concurrency finding", async () => {
    const source = `
import asyncio
from openai import OpenAI

client = OpenAI()

async def fetch_all(prompts):
    tasks = []
    for prompt in prompts:
        tasks.append(client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": prompt}]))
    return await asyncio.gather(*tasks)
`;

    const findings = detectPythonWaste(
      [
        makeMatch({
          line: 9,
          frequency: "bounded-loop",
          loopContext: true,
        }),
      ],
      source,
      "/project/src/example.py"
    );
    const finding = findings.find((item) => item.type === "concurrency_control");
    assert.ok(finding, "expected concurrency finding");
    assert.equal(finding!.severity, "high");
  });

  await run("python waste: non-python paths are ignored", async () => {
    const findings = detectPythonWaste(
      [
        {
          kind: "sdk",
          provider: "openai",
          packageName: "openai",
          methodChain: "client.chat.completions.create",
          confidence: 1,
          line: 1,
          column: 0,
          span: pointSpan(1, 0),
          frequency: "single",
          loopContext: false,
          enclosingFunction: null,
        },
      ],
      `client.chat.completions.create({ model: "gpt-4o-mini" });`,
      "/project/src/example.ts"
    );

    assert.deepEqual(findings, []);
  });

  await run(
    "python waste: same method in two distinct functions creates cross-function batch finding",
    async () => {
      const source = `
import anthropic

_client = anthropic.Anthropic()

def summarize(text: str) -> str:
    response = _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": text}],
    )
    return response.content[0].text

def summarize_with_style(text: str, style: str) -> str:
    response = _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Summarize in {style} style: {text}"}],
    )
    return response.content[0].text
`;

      const findings = detectPythonWaste(
        [
          makeMatch({
            provider: "anthropic",
            packageName: "anthropic",
            methodChain: "messages.create",
            line: 7,
            frequency: "single",
            enclosingFunction: "summarize",
          }),
          makeMatch({
            provider: "anthropic",
            packageName: "anthropic",
            methodChain: "messages.create",
            line: 16,
            frequency: "single",
            enclosingFunction: "summarize_with_style",
          }),
        ],
        source,
        "/project/src/anthropic_helper.py"
      );

      const batchFindings = findings.filter((f) => f.type === "batch");
      assert.equal(batchFindings.length, 1, "expected exactly one batch finding");
      assert.equal(batchFindings[0].line, 7, "batch finding should be anchored at the earliest line");
    }
  );

  await run(
    "python waste: cross-function batch is suppressed when a concurrency guard appears near one call site",
    async () => {
      // The semaphore is within ~5 lines of the call in process_batch, so
      // surroundingWindow(lines, 14, 5) will include it and suppress the finding.
      const source = `
import anthropic
import asyncio

_client = anthropic.Anthropic()
semaphore = asyncio.Semaphore(5)

def summarize(text: str) -> str:
    response = _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": text}],
    )
    return response.content[0].text

async def process_batch(texts):
    async with semaphore:
        response = _client.messages.create(
            model="claude-3-haiku-20240307",
            max_tokens=512,
            messages=[{"role": "user", "content": texts[0]}],
        )
    return response.content[0].text
`;

      const findings = detectPythonWaste(
        [
          makeMatch({
            provider: "anthropic",
            packageName: "anthropic",
            methodChain: "messages.create",
            line: 9,
            frequency: "single",
            enclosingFunction: "summarize",
          }),
          makeMatch({
            provider: "anthropic",
            packageName: "anthropic",
            methodChain: "messages.create",
            line: 18,
            frequency: "single",
            enclosingFunction: "process_batch",
          }),
        ],
        source,
        "/project/src/anthropic_helper.py"
      );

      const batchFindings = findings.filter((f) => f.type === "batch");
      assert.equal(
        batchFindings.length,
        0,
        "cross-function batch should be suppressed when a concurrency guard is near one call site"
      );
    }
  );

  await run(
    "python waste: different methodChains in two functions do NOT create a cross-function batch finding",
    async () => {
      const source = `
import anthropic

_client = anthropic.Anthropic()

def summarize(text: str) -> str:
    response = _client.messages.create(
        model="claude-3-haiku-20240307",
        messages=[{"role": "user", "content": text}],
    )
    return response.content[0].text

def generate_image(prompt: str) -> str:
    response = _client.completions.create(
        model="claude-instant-1",
        max_tokens_to_sample=100,
        prompt=prompt,
    )
    return response.completion
`;

      const findings = detectPythonWaste(
        [
          makeMatch({
            provider: "anthropic",
            packageName: "anthropic",
            methodChain: "messages.create",
            line: 7,
            frequency: "single",
            enclosingFunction: "summarize",
          }),
          makeMatch({
            provider: "anthropic",
            packageName: "anthropic",
            methodChain: "completions.create",
            line: 14,
            frequency: "single",
            enclosingFunction: "generate_image",
          }),
        ],
        source,
        "/project/src/anthropic_helper.py"
      );

      const batchFindings = findings.filter((f) => f.type === "batch");
      assert.equal(batchFindings.length, 0, "different methodChains should not produce a batch finding");
    }
  );
})();
