import assert from "node:assert/strict";
import { newLocalScanId } from "../scan-id";

const FORMAT = /^local-\d+-[0-9a-f]{8}$/;

async function runTests() {
  // 1. Format: matches local-<digits>-<8 hex chars>
  {
    const id = newLocalScanId();
    assert.match(id, FORMAT, `expected ${id} to match ${FORMAT}`);
  }

  // 2. Uniqueness: 1000 sequential calls produce 1000 distinct IDs
  {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newLocalScanId());
    }
    assert.equal(ids.size, 1000, `expected 1000 unique IDs, got ${ids.size}`);
  }

  // 3. Timestamp prefix is non-decreasing across 100 calls
  {
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      const id = newLocalScanId();
      const ts = Number(id.split("-")[1]);
      assert.ok(ts >= prev, `timestamp regressed: ${ts} < ${prev}`);
      prev = ts;
    }
  }

  console.log("PASS scan-id");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
