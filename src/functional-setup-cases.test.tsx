// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { InitialSetupGuide } from "./InitialSetupGuide";
import { testDom } from "./testDom";
import { uiFixtures } from "./domain/functional-fixtures";
import type { GoogleWorkspaceClient } from "./google/client";
import type { AppState } from "./domain/types";
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
});
it("PF-F224 every class/people/number/name change revokes roster review; seats/layout revoke seat review", async () => {
  for (const [type, mutate] of [
    [
      "class",
      (s: AppState) => {
        s.classId = "new-class";
      },
    ],
    [
      "count",
      (s: AppState) => {
        s.students.pop();
      },
    ],
    [
      "number",
      (s: AppState) => {
        s.students[0].number = 77;
      },
    ],
    [
      "name",
      (s: AppState) => {
        s.students[0].name = "改名";
      },
    ],
    [
      "seat",
      (s: AppState) => {
        s.students[0].seat = null;
      },
    ],
    [
      "layout",
      (s: AppState) => {
        s.settings!.activeSeatLayoutId = "changed-layout";
      },
    ],
  ] as const) {
    dom = testDom();
    const state = uiFixtures().R6;
    state.settings!.folderId = "folder";
    const save = vi.fn(),
      client = { isConnected: () => true } as GoogleWorkspaceClient;
    const render = (s: AppState) =>
      dom.render(
        <InitialSetupGuide
          state={s}
          client={client}
          sample={false}
          busy={false}
          onSaveLedger={save}
        />,
      );
    await render(state);
    const roster = () =>
        dom.input(
          "対象クラスの人数と全員の番号を確認しました",
        ) as HTMLInputElement,
      seats = () =>
        dom.input("座席・未配置者・配布順を確認しました") as HTMLInputElement;
    await dom.click(roster());
    await dom.click(seats());
    expect(dom.button("確認した設定をSheetsへ保存").disabled).toBe(false);
    const changed = structuredClone(state);
    mutate(changed);
    await render(changed);
    expect(roster().checked).toBe(type === "seat" || type === "layout");
    expect(seats().checked).toBe(false);
    expect(dom.button("確認した設定をSheetsへ保存").disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await dom.close();
  }
});
