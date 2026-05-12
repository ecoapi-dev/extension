import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { runParity, parseAllowlist } from "./parity";

// Fixtures are excluded from tsc compilation (tsconfig.scanner-tests.json) so
// they remain in the source tree. After compile __dirname is dist-test/test/,
// so we resolve back into src/test/fixtures/parity/ via ../../src/...
const FIXTURE_DIR = path.join(__dirname, "..", "..", "src", "test", "fixtures", "parity");
const PARITY_MD = path.join(__dirname, "..", "..", "docs", "accuracy", "PARITY.md");

(async () => {
  const allowlist = parseAllowlist(fs.readFileSync(PARITY_MD, "utf8"));
  const { allDivergences, unannotated } = await runParity(FIXTURE_DIR, allowlist);

  if (unannotated.length > 0) {
    console.error("UNANNOTATED PARITY DIVERGENCES:");
    for (const div of unannotated) {
      console.error(`  ${path.relative(FIXTURE_DIR, div.file)}`);
      for (const r of div.ast) {
        console.error(`    AST-only: ${r.provider} ${r.method} L${r.line}`);
      }
      for (const r of div.regex) {
        console.error(`    regex-only: ${r.provider} ${r.method} L${r.line}`);
      }
      for (const d of div.disagreed) {
        console.error(`    disagreement L${d.line}: AST=${d.ast.provider} ${d.ast.method} vs regex=${d.regex.provider} ${d.regex.method}`);
      }
    }
    console.error("\nFix the bug, or add an entry to docs/accuracy/PARITY.md.");
    process.exit(1);
  }

  console.log(`PASS parity (${allDivergences.length} documented divergences, 0 unannotated)`);
})().catch((err) => { console.error(err); process.exit(1); });
