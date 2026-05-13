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
})();
