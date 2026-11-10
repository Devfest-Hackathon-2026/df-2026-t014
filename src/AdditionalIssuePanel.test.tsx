import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdditionalIssuePanel } from "./AdditionalIssuePanel";
import { createInitialState } from "./domain/seed";
import { createCollection } from "./domain/logic";
import { prepareAdditionalIssue } from "./domain/additionalIssue";
import { beginSaveOperation } from "./domain/operations";

describe("additional issue panel cleanup guard", () => {
  it("disables prepared-issue resume while deletion is unfinished", () => {
    const base = createInitialState();
    const students = base.students.slice(0, 3);
    const collection = createCollection(
      {
        title: "対象票",
        className: base.className,
        pageCount: 1,
        requiredPages: [1],
        qrCorner: "top-right",
        duplex: false,
        order: "row",
        reverse: false,
      },
      students.slice(0, 2),
    );
    const prepared = prepareAdditionalIssue(
      { ...base, students, collections: [collection] },
      collection.id,
      [students[2].id],
      { actor: "teacher", reason: "転入" },
    );
    const started = beginSaveOperation(prepared.state, {
      collectionId: collection.id,
      kind: "print",
      storageMode: "record-only",
    });
    const state = {
      ...started.state,
      operations: started.state.operations!.map((operation) => ({
        ...operation,
        studentIds: prepared.addedStudentIds,
      })),
      cleanupOperations: [
        {
          id: "cleanup",
          collectionIds: [collection.id],
          actor: "teacher",
          reason: "整理",
          createdAt: "now",
          status: "failed" as const,
          files: [],
        },
      ],
    };
    const render = (input: typeof state) =>
      renderToStaticMarkup(
        <AdditionalIssuePanel
          state={input}
          collection={prepared.collection}
          sample
          busy={false}
          onCommit={async () => {}}
          onGenerated={() => {}}
          onError={() => {}}
        />,
      );
    const html = render(state);
    const resumeButton = [
      ...html.matchAll(/<button([^>]*)>[\s\S]*?<\/button>/g),
    ].find((match) => match[0].includes("追加発行を再開"));
    expect(resumeButton?.[1]).toContain('disabled=""');
    expect(html).toContain("整理・削除処理中");
    const available = render({ ...state, cleanupOperations: [] });
    const availableButton = [
      ...available.matchAll(/<button([^>]*)>[\s\S]*?<\/button>/g),
    ].find((match) => match[0].includes("追加発行を再開"));
    expect(availableButton).toBeDefined();
    expect(availableButton![1]).not.toContain("disabled");
  });
});
