import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Collection, ScanPage } from "./types";
import {
  baseState,
  record,
  scanBatch,
  testActor,
  issued,
} from "./functional-fixtures";
import {
  createRevision,
  setCollectionStatus,
  setRecipientRequirement,
} from "./workflows";
import { getStudentStatus, recordBatch } from "./logic";
const truth = JSON.parse(
  readFileSync("tests/fixtures/pixel-source-truth.json", "utf8"),
) as {
  collection: Collection;
  results: Array<{
    ids: string[];
    name: string;
    observed: unknown;
    pass: boolean;
  }>;
};
const collection = truth.collection;
function initial() {
  return {
    ...baseState(collection.recipients),
    collections: [structuredClone(collection)],
  };
}
function pages(id: string) {
  const result = truth.results.find((r) => r.ids.includes(id))!;
  expect(result.pass).toBe(true);
  expect(Array.isArray(result.observed)).toBe(true);
  return structuredClone(result.observed) as ScanPage[];
}
it("PF-F139 PF-F140 actual Chrome shuffled QR outputs join original generation manifest into exact per-person logical page receipts", () => {
  const p = pages("PF-F140"),
    state = record(initial(), collection, p);
  expect(state.receipts).toHaveLength(4);
  for (const person of collection.recipients)
    expect(
      getStudentStatus(collection, person.id, state.receipts),
    ).toMatchObject({ status: "complete", receivedCount: 2, requiredCount: 2 });
  expect(
    state.receipts.map((r) => [r.studentId, r.pageNumber, r.sourcePage]),
  ).toEqual([
    ["S02", 2, 1],
    ["S01", 1, 2],
    ["S02", 1, 3],
    ["S01", 2, 4],
  ]);
  const q = pages("PF-F139"),
    one = record(initial(), collection, q);
  expect(one.receipts[0]).toMatchObject({
    studentId: "S01",
    pageNumber: 2,
    sourcePage: 1,
  });
});
it("PF-F141 PF-F148 real same-bundle duplicate is pending; repeated-region same QR creates only one receipt", () => {
  const p = pages("PF-F141"),
    state = record(initial(), collection, p);
  expect(state.receipts).toHaveLength(2);
  expect(
    state.batches[0].pages.filter((p) => p.resolution === "pending"),
  ).toHaveLength(1);
  expect(state.batches[0].pages.find((p) => p.sourcePage === 2)?.status).toBe(
    "duplicate",
  );
  expect(getStudentStatus(collection, "S01", state.receipts).status).toBe(
    "complete",
  );
  const once = record(initial(), collection, pages("PF-F148"));
  expect(once.receipts).toHaveLength(1);
  expect(record(once, collection, pages("PF-F148")).receipts).toEqual(
    once.receipts,
  );
});
it("PF-F143 PF-F144 PF-F145 PF-F147 PF-F149 PF-F150 PF-F154 PF-F162 PF-F168 actual unresolved/spacer outputs never create or infer a recipient", () => {
  for (const id of [
    "PF-F143",
    "PF-F144",
    "PF-F145",
    "PF-F147",
    "PF-F149",
    "PF-F150",
    "PF-F154",
    "PF-F162",
    "PF-F168",
  ]) {
    const p = pages(id),
      s = record(initial(), collection, p, id);
    expect(s.receipts).toHaveLength(0);
    expect(s.batches[0].pages.map((p) => p.sourcePage)).toEqual(
      p.map((p) => p.sourcePage),
    );
    for (const person of collection.recipients)
      expect(getStudentStatus(collection, person.id, s.receipts).status).toBe(
        "uncollected",
      );
  }
});
it("PF-F160 PF-F169 real obscured second page stays partial then actual later second page completes without replacing first receipt", () => {
  const first = record(initial(), collection, pages("PF-F160"), "first");
  expect(first.receipts).toHaveLength(1);
  expect(getStudentStatus(collection, "S01", first.receipts)).toMatchObject({
    status: "partial",
    receivedCount: 1,
    requiredCount: 2,
  });
  expect(first.batches[0].pages[1]).toMatchObject({
    status: "unreadable",
    resolution: "pending",
    sourcePage: 2,
  });
  expect(first.batches[0].pages[1].studentId).toBeUndefined();
  const final = record(first, collection, pages("PF-F169"), "second");
  expect(final.receipts).toHaveLength(2);
  expect(final.receipts[0]).toEqual(first.receipts[0]);
  expect(getStudentStatus(collection, "S01", final.receipts)).toMatchObject({
    status: "complete",
    receivedCount: 2,
    requiredCount: 2,
  });
  expect(new Set(final.receipts.map((r) => r.batchId)).size).toBe(2);
});
it("PF-F067 actual inactive QR result plus forcibly accepted input cannot record a generating collection", () => {
  const state = initial();
  state.collections[0].status = "generating";
  state.collections[0].tokens = state.collections[0].tokens.map((t) => ({
    ...t,
    active: false,
  }));
  const p = pages("PF-F150");
  expect(p[0]).toMatchObject({ status: "unknown", resolution: "pending" });
  const forced = p.map((p) => ({
    ...p,
    status: "matched" as const,
    resolution: "accepted" as const,
  }));
  expect(() =>
    recordBatch(state, scanBatch(state.collections[0], forced), forced),
  ).toThrow(/発行|生成/);
  expect(state.receipts).toHaveLength(0);
});

it("PF-F152 actual cross-class foreign QR cannot be assigned to same-name class-A student", () => {
  const a = issued(
    {},
    collection.recipients.map((s, i) => ({ ...s, id: "A" + i })),
  );
  for (const p of [pages("PF-F152"), pages("PF-F143")]) {
    const state = record(a.state, a.collection, p);
    expect(state.receipts).toHaveLength(0);
    expect(state.students.map((s) => s.name)).toEqual(
      collection.recipients.map((s) => s.name),
    );
    expect(
      state.batches[0].pages.every((p) => p.resolution === "pending"),
    ).toBe(true);
  }
});
it("PF-F153 actual old-version QR requires explicit per-student acceptance change after selecting old collection", () => {
  const rev = createRevision(
    initial(),
    collection.id,
    { title: "新版" },
    testActor,
  );
  let state = setCollectionStatus(
    setCollectionStatus(rev.state, rev.collection.id, "generating", testActor),
    rev.collection.id,
    "ready",
    testActor,
  );
  const current = state.collections.find((c) => c.id === rev.collection.id)!;
  state = record(state, current, pages("PF-F153"), "newversion");
  expect(state.receipts).toHaveLength(0);
  const old = state.collections.find((c) => c.id === collection.id)!;
  expect(old.recipientStates?.S01).toBe("superseded");
  const oldQr = [pages("PF-F160")[0]];
  state = record(state, old, oldQr, "oldversion");
  expect(state.receipts).toHaveLength(0);
  state = setRecipientRequirement(state, old.id, "S01", "required", testActor);
  state = record(
    state,
    state.collections.find((c) => c.id === old.id)!,
    oldQr,
    "explicit-old-version",
  );
  expect(state.receipts).toHaveLength(1);
  expect(state.receipts[0]).toMatchObject({
    collectionId: old.id,
    versionId: old.versionId,
    studentId: "S01",
    pageNumber: 1,
  });
  expect(
    state.collections.find((c) => c.id === current.id)?.recipientStates?.S01,
  ).toBe("superseded");
});
