import { describe, expect, it } from "vitest";
import { createCollection } from "./logic";
import { sanitizeStateForStorage } from "./persistence";
import { createInitialState } from "./seed";
import { switchClassWorkspace } from "./workspaces";
import type { AppState, CleanupOperation } from "./types";
describe("cleanup metadata persistence", () => {
  it("preserves archive state and cleanup plans across class switching, rejecting orphan targets", () => {
    const base = createInitialState();
    const collection = {
      ...createCollection(
        {
          title: "年度保管",
          className: base.className,
          pageCount: 1,
          requiredPages: [1],
          qrCorner: "top-right",
          duplex: false,
          order: "row",
          reverse: false,
        },
        base.students,
      ),
      archivedAt: "2026-11-10T00:00:00Z",
    };
    const operation: CleanupOperation = {
      id: "cleanup",
      collectionIds: [collection.id],
      actor: "teacher",
      reason: "年度終了",
      createdAt: "now",
      status: "planned",
      files: [
        {
          fileId: "file",
          name: "print.pdf",
          collectionIds: [collection.id],
          status: "pending",
        },
      ],
    };
    const state: AppState = {
      ...base,
      classId: "class-a",
      collections: [collection],
      settings: { schoolYear: "2026" },
      cleanupOperations: [operation],
    };
    expect(sanitizeStateForStorage(state)?.cleanupOperations).toEqual([
      operation,
    ]);
    const switched = switchClassWorkspace(state, {
      id: "class-b",
      className: "B組",
      students: [],
    });
    expect(
      sanitizeStateForStorage(switched)?.savedClasses?.[0].cleanupOperations,
    ).toEqual([operation]);
    expect(
      switchClassWorkspace(switched, { id: "class-a", className: "A組" })
        .settings?.schoolYear,
    ).toBe("2026");
    expect(
      sanitizeStateForStorage({
        ...state,
        cleanupOperations: [{ ...operation, collectionIds: ["unknown"] }],
      }),
    ).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        cleanupOperations: [{ ...operation, status: "complete" }],
      }),
    ).toBeNull();
    expect(
      sanitizeStateForStorage({
        ...state,
        cleanupOperations: [
          {
            ...operation,
            files: [{ ...operation.files[0], collectionIds: ["unknown"] }],
          },
        ],
      }),
    ).toBeNull();
  });
});
