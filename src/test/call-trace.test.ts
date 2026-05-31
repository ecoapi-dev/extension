import assert from "node:assert/strict";
import { directTrace } from "../scanner/call-trace";
import { pointSpan } from "../scanner/source-span";

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

run("directTrace: hops is 0 and both sites are equal", () => {
  const span = pointSpan(12, 4);
  const trace = directTrace("services/chat.ts", span);
  assert.equal(trace.hops, 0);
  assert.deepEqual(trace.callSite, { file: "services/chat.ts", span });
  assert.deepEqual(trace.resolvedSite, trace.callSite);
});
