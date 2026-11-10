import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { uiFixtures } from "./functional-fixtures";
import { sanitizeStateForStorage } from "./persistence";
describe("persistent functional UI fixtures", () => {
  for (const [name, state] of Object.entries(uiFixtures()))
    it(`writes valid fictional ${name} backup for UI execution`, () => {
      const safe = sanitizeStateForStorage(state);
      expect(safe).not.toBeNull();
      mkdirSync("artifacts/test-execution/functional/fixtures", {
        recursive: true,
      });
      writeFileSync(
        `artifacts/test-execution/functional/fixtures/${name}.json`,
        JSON.stringify(safe, null, 2),
      );
    });
});
