// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { RosterImportPanel } from "./RosterImportPanel";
import { InitialSetupGuide } from "./InitialSetupGuide";
import { testDom } from "./testDom";
import { createCollection } from "./domain/logic";
import type { AppState } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
import { NEW_STUDENT } from "./domain/rosterCsv";
const headers = ["出席番号", "氏名", "生徒ID", "行", "列"];
const baseRows = [headers, ["1", "青木新姓", "S-A", "", ""]];
function fixture(): AppState {
  const students = [
    {
      id: "S-A",
      classroomUserId: "C-A",
      name: "青木葵",
      number: 1,
      seat: { row: 0, col: 0 },
    },
    {
      id: "S-B",
      classroomUserId: "C-B",
      name: "佐藤蓮",
      number: 2,
      seat: { row: 0, col: 1 },
    },
    {
      id: "S-C",
      classroomUserId: "C-C",
      name: "佐藤蓮",
      number: 3,
      seat: { row: 1, col: 0 },
    },
  ];
  const collection = createCollection(
    {
      title: "旧発行",
      className: "RS3",
      dueDate: "",
      pageCount: 1,
      requiredPages: [1],
      qrCorner: "top-right",
      duplex: false,
      order: "number",
      reverse: false,
    },
    students,
  );
  return {
    schemaVersion: 1,
    classId: "RS3",
    className: "RS3",
    students,
    collections: [collection],
    batches: [],
    receipts: [],
    events: [],
    settings: { googleAccountId: "teacher-A", activeSeatLayoutId: "L" },
    seatLayouts: [
      {
        id: "L",
        name: "2x2",
        createdAt: "now",
        rows: 2,
        cols: 2,
        blockedCells: [{ row: 1, col: 1 }],
        students,
        order: "row",
        reverse: false,
      },
    ],
  };
}
let h: ReturnType<typeof testDom> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.restoreAllMocks();
});
async function setup(values: string[][] = baseRows, sample = false) {
  h = testDom();
  const state = fixture();
  let account: string | undefined = "teacher-A";
  const client = {
    isConnected: vi.fn(() => !!account),
    getIdentity: vi.fn(() =>
      account
        ? { id: account, email: account + "@example.test", name: "架空先生" }
        : undefined,
    ),
    pickFiles: vi.fn(async () => [
      {
        id: "book",
        name: "架空名簿",
        mimeType: "application/vnd.google-apps.spreadsheet",
      },
    ]),
    readRosterSpreadsheet: vi.fn(async () => ({
      id: "book",
      title: "架空名簿",
      sheets: [
        { sheetId: 7, title: "説明", rowCount: 20, columnCount: 5 },
        { sheetId: 9, title: "名簿", rowCount: 20, columnCount: 5 },
      ],
    })),
    readRosterSheet: vi.fn(async (_id: string, tab: number) => ({
      title: "架空名簿",
      sheetTitle: tab === 9 ? "名簿" : "説明",
      values,
    })),
  };
  const onChange = vi.fn(),
    onBusy = vi.fn();
  let current = state;
  const render = async (next = current) => {
    current = next;
    await h!.render(
      <RosterImportPanel
        state={next}
        client={client as unknown as GoogleWorkspaceClient}
        busy={false}
        sample={sample}
        actor="teacher-A"
        onChange={onChange}
        onBusyChange={onBusy}
      />,
    );
  };
  await render();
  const pick = async () => {
    await h!.click(h!.button("名簿のSheetsを選ぶ"));
  };
  const read = async () => {
    await pick();
    await h!.click(h!.button("選んだシートを読み込む"));
  };
  const preview = async () => {
    await read();
    await h!.click(h!.button("この列で対応先を確認"));
  };
  const confirm = async () => {
    await h!.click(h!.input("人数・氏名・番号・座席と"));
  };
  const mapping = (row = 2) =>
    h!.container.querySelector(
      `[aria-label="${row}行目の対応先"]`,
    ) as HTMLSelectElement;
  const csv = async (
    text: string,
    size = new TextEncoder().encode(text).length,
  ) => {
    const input = h!.container.querySelector("input[type=file]")!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ name: "架空.csv", size, text: async () => text }],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  return {
    state,
    client,
    onChange,
    onBusy,
    render,
    pick,
    read,
    preview,
    confirm,
    mapping,
    csv,
    setAccount: (id: string | undefined) => {
      account = id;
    },
  };
}
describe("PF roster UI execution in jsdom with Google response stubs", () => {
  it("PF-S001 staged explicit import only changes local state, never calls a writer", async () => {
    const x = await setup();
    expect(x.client.pickFiles).not.toHaveBeenCalled();
    await x.pick();
    expect(x.client.readRosterSheet).not.toHaveBeenCalled();
    expect(x.onChange).not.toHaveBeenCalled();
    await h!.click(h!.button("選んだシートを読み込む"));
    expect(x.onChange).not.toHaveBeenCalled();
    await h!.click(h!.button("この列で対応先を確認"));
    expect(x.mapping().value).toBe("S-A");
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    expect(x.onChange).toHaveBeenCalledOnce();
    expect(x.onChange.mock.calls[0][0].students[0].name).toBe("青木新姓");
    expect(h!.container.textContent).toContain("次に座席を確認");
  });
  it("PF-S002 PF-G093 sample prevents Sheets and CSV imports", async () => {
    const x = await setup(baseRows, true);
    expect(h!.button("名簿のSheetsを選ぶ").disabled).toBe(true);
    expect(
      (h!.container.querySelector("input[type=file]") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await h!.click(h!.button("名簿のSheetsを選ぶ"));
    await x.csv("出席番号,氏名\n1,実名禁止");
    expect(x.client.pickFiles).not.toHaveBeenCalled();
    expect(x.onChange).not.toHaveBeenCalled();
    expect(h!.container.textContent).not.toContain("実名禁止");
  });
  it("PF-S003 selects second tab by ID not first entry", async () => {
    const x = await setup();
    await x.pick();
    await h!.value(h!.input("名簿のシート"), "9");
    await h!.click(h!.button("選んだシートを読み込む"));
    expect(x.client.readRosterSheet).toHaveBeenCalledWith("book", 9);
    expect(h!.container.textContent).toContain("架空名簿 / 名簿");
  });
  it("PF-S005 header row 3 preserves source rows 4 and 6 across blank row", async () => {
    const x = await setup([
      ["架空タイトル"],
      [],
      headers,
      ["1", "青木", "S-A"],
      [],
      ["2", "佐藤", "S-B"],
    ]);
    await x.read();
    await h!.value(h!.input("見出しの行"), "3");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(x.mapping(4).value).toBe("S-A");
    expect(x.mapping(6).value).toBe("S-B");
    expect(x.mapping(2)).toBeNull();
  });
  it("PF-S006 ambiguous name headers require explicit selection", async () => {
    const x = await setup([
      ["番号", "氏名", "名前"],
      ["1", "青木", "別名"],
    ]);
    await x.read();
    expect(h!.input("氏名").value).toBe("-1");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(h!.container.textContent).toContain("出席番号・氏名の列を選択");
    await h!.value(h!.input("氏名"), "1");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(x.mapping()).not.toBeNull();
  });
  it("PF-S007 missing mandatory field and duplicate column are blocked before mapping", async () => {
    const x = await setup();
    await x.read();
    await h!.value(h!.input("氏名"), "-1");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(h!.container.textContent).toContain("列を選択");
    await h!.value(h!.input("氏名"), "0");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(h!.container.textContent).toContain("同じ列");
    expect(x.mapping()).toBeNull();
  });
  it("PF-S008 seat columns and cell values must be paired", async () => {
    const x = await setup([headers, ["1", "青木", "S-A", "1", ""]]);
    await x.read();
    await h!.value(h!.input("座席の列"), "-1");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(h!.container.textContent).toContain("両方");
    await h!.value(h!.input("座席の列"), "4");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(h!.container.textContent).toContain("座席の列");
    expect(x.mapping()).toBeNull();
  });
  it("PF-S009 column header and tab changes clear old mapping and confirmation", async () => {
    const x = await setup([
      headers,
      ["1", "青木", "S-A"],
      ["2", "佐藤", "S-B"],
    ]);
    await x.preview();
    await x.confirm();
    await h!.value(h!.input("生徒ID（任意）"), "-1");
    expect(x.mapping()).toBeNull();
    await h!.click(h!.button("この列で対応先を確認"));
    expect(
      (h!.input("人数・氏名・番号・座席と") as HTMLInputElement).checked,
    ).toBe(false);
    await h!.value(h!.input("見出しの行"), "2");
    expect(x.mapping()).toBeNull();
    await h!.value(h!.input("名簿のシート"), "9");
    expect(
      h!.container.querySelector('[aria-label="名簿の列を確認"]'),
    ).toBeNull();
    expect(x.onChange).not.toHaveBeenCalled();
  });
  it("PF-S010 validates 0, 1, 1000 and 1001 rows without applying truncation", async () => {
    for (const n of [0, 1, 1000, 1001]) {
      const x = await setup([
        headers,
        ...Array.from({ length: n }, (_, i) => [String(i + 1), "架空" + i]),
      ]);
      await x.preview();
      if (n === 1 || n === 1000) {
        expect(
          h!.container.querySelectorAll('select[aria-label$="行目の対応先"]'),
        ).toHaveLength(n);
      } else {
        expect(
          h!.container.querySelectorAll('select[aria-label$="行目の対応先"]'),
        ).toHaveLength(0);
        expect(h!.container.textContent).toMatch(/名簿|見出し/);
      }
      expect(x.onChange).not.toHaveBeenCalled();
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S015 duplicate external IDs stop before row mapping", async () => {
    const x = await setup([headers, ["1", "A", "same"], ["2", "B", "same"]]);
    await x.preview();
    expect(h!.container.textContent).toContain("生徒IDが重複");
    expect(x.mapping()).toBeNull();
    expect(x.onChange).not.toHaveBeenCalled();
  });
  it("PF-S016 integer boundaries reject zero negative fractional and unsafe numbers", async () => {
    for (const number of [
      "1",
      "001",
      "9007199254740991",
      "0",
      "-1",
      "1.5",
      "9007199254740992",
    ]) {
      const x = await setup([headers, [number, "架空"]]);
      await x.preview();
      expect(!!x.mapping()).toBe(
        ["1", "001", "9007199254740991"].includes(number),
      );
      expect(x.onChange).not.toHaveBeenCalled();
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S017 ignores only selected empty columns and rejects partial rows", async () => {
    const x = await setup([
      ["番号", "氏名", "備考"],
      ["", "", "備考だけ"],
      ["1", "青木"],
    ]);
    await x.preview();
    expect(x.mapping(2)).toBeNull();
    expect(x.mapping(3)).not.toBeNull();
    await h!.close();
    h = undefined;
    const y = await setup([
      ["番号", "氏名"],
      ["", "氏名だけ"],
    ]);
    await y.preview();
    expect(y.mapping()).toBeNull();
    expect(h!.container.textContent).toContain("出席番号");
  });
  it("PF-S018 seat 1 and 100 parse, 0 and 101 reject; empty seats retain existing", async () => {
    for (const seat of ["1", "100", "0", "101"]) {
      const x = await setup([headers, ["4", "追加", "", seat, seat]]);
      await x.preview();
      expect(!!x.mapping()).toBe(["1", "100"].includes(seat));
      await h!.close();
      h = undefined;
    }
    const x = await setup();
    await x.preview();
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    expect(x.onChange.mock.calls[0][0].students[0].seat).toEqual({
      row: 0,
      col: 0,
    });
  });
  it("PF-S019 explicit confirm is still required after ID suggestion and mapping edits", async () => {
    const x = await setup();
    await x.preview();
    expect(x.mapping().value).toBe("S-A");
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
    await x.confirm();
    await h!.value(x.mapping(), "S-A");
    expect(
      (h!.input("人数・氏名・番号・座席と") as HTMLInputElement).checked,
    ).toBe(false);
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
  });
  it("PF-S020 same names or unknown ID never choose existing identity", async () => {
    const x = await setup([
      headers,
      ["2", "佐藤蓮", "unknown"],
      ["3", "佐藤蓮"],
    ]);
    await x.preview();
    expect(x.mapping(2).value).toBe("");
    expect(x.mapping(3).value).toBe("");
    await x.confirm();
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
  });
  it("PF-S021 unlisted students and issued snapshots survive reviewed Sheets import", async () => {
    const x = await setup();
    const before = structuredClone(x.state.collections);
    await x.preview();
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    const next = x.onChange.mock.calls[0][0] as AppState;
    expect(next.students).toHaveLength(3);
    expect(next.students.find((s) => s.id === "S-B")).toEqual(
      x.state.students[1],
    );
    expect(next.collections).toEqual(before);
    expect(next.events.at(-1)?.action).toBe("import_roster_sheets");
  });
  it("PF-S022 changed roster or layout invalidates a pending preview", async () => {
    const x = await setup();
    await x.preview();
    await x.confirm();
    await x.render({
      ...x.state,
      students: x.state.students.map((s, i) => (i ? s : { ...s, number: 4 })),
    });
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
    expect(h!.container.textContent).toContain("変わりました");
    await h!.click(h!.button("確認した名簿を反映"));
    expect(x.onChange).not.toHaveBeenCalled();
  });
  it("PF-S023 delayed read cannot enter another class or unmounted panel", async () => {
    const x = await setup();
    let release!: (
      v: Awaited<ReturnType<typeof x.client.readRosterSheet>>,
    ) => void;
    x.client.readRosterSheet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await x.pick();
    await h!.click(h!.button("選んだシートを読み込む"));
    await x.render({ ...x.state, classId: "different" });
    await act(async () => {
      release({ title: "old", sheetTitle: "old", values: baseRows });
    });
    expect(h!.container.textContent).toContain("変わりました");
    expect(x.mapping()).toBeNull();
    expect(x.onChange).not.toHaveBeenCalled();
    await h!.close();
    h = undefined;
    const y = await setup();
    let done!: (
      v: Awaited<ReturnType<typeof y.client.readRosterSheet>>,
    ) => void;
    y.client.readRosterSheet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    await y.pick();
    await h!.click(h!.button("選んだシートを読み込む"));
    await h!.close();
    h = undefined;
    await act(async () => {
      done({ title: "old", sheetTitle: "old", values: baseRows });
    });
    expect(y.onChange).not.toHaveBeenCalled();
    expect(y.onBusy).toHaveBeenLastCalledWith(false);
  });
  it("PF-S024 changed or expired account blocks apply after preview", async () => {
    for (const next of ["teacher-B", undefined]) {
      const x = await setup();
      await x.preview();
      await x.confirm();
      x.setAccount(next);
      await x.render();
      expect(h!.button("確認した名簿を反映").disabled).toBe(true);
      expect(h!.container.textContent).toContain("Google接続が変わりました");
      await h!.click(h!.button("確認した名簿を反映"));
      expect(x.onChange).not.toHaveBeenCalled();
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S025 cancelled Picker preserves an existing review and confirmed state", async () => {
    const x = await setup();
    await x.preview();
    await x.confirm();
    x.client.pickFiles.mockResolvedValueOnce([]);
    await x.pick();
    expect(x.mapping().value).toBe("S-A");
    expect(
      (h!.input("人数・氏名・番号・座席と") as HTMLInputElement).checked,
    ).toBe(true);
    expect(x.onChange).not.toHaveBeenCalled();
  });
  it("PF-S027 adapter denial or malformed values is an error, not success UI", async () => {
    for (const message of [
      "Google API 403: denied",
      "名簿シートのセル形式を確認できません。",
    ]) {
      const x = await setup();
      x.client.readRosterSheet.mockRejectedValueOnce(new Error(message));
      await x.read();
      expect(h!.container.textContent).toContain(message);
      expect(x.mapping()).toBeNull();
      expect(x.onChange).not.toHaveBeenCalled();
      expect(h!.container.textContent).not.toContain("反映しました");
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S028 CSV and Sheets produce same roster with separate audit sources", async () => {
    const x = await setup();
    await x.preview();
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    const fromSheet = x.onChange.mock.calls[0][0] as AppState;
    await h!.close();
    h = undefined;
    const y = await setup();
    await y.csv("出席番号,氏名,生徒ID\n1,青木新姓,S-A");
    await y.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    const fromCsv = y.onChange.mock.calls[0][0] as AppState;
    expect(fromCsv.students).toEqual(fromSheet.students);
    expect(fromSheet.events.at(-1)?.action).toBe("import_roster_sheets");
    expect(fromCsv.events.at(-1)?.action).toBe("import_roster_csv");
  });
  it("PF-S029 CSV 1MiB inclusive file boundary uses bytes not Sheets cell limit", async () => {
    for (const size of [1048575, 1048576, 1048577]) {
      const x = await setup();
      const text = "出席番号,氏名,生徒ID\n1,青木,S-A\n";
      const padded =
        text + "\n".repeat(size - new TextEncoder().encode(text).length);
      expect(new TextEncoder().encode(padded).length).toBe(size);
      await x.csv(padded);
      expect(!!x.mapping()).toBe(size <= 1048576);
      if (size > 1048576)
        expect(h!.container.textContent).toContain("1 MiB以下");
      expect(x.onChange).not.toHaveBeenCalled();
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S030 retained-seat collision aisle and out-of-layout apply are refused", async () => {
    for (const [row, col] of [
      ["1", "2"],
      ["2", "2"],
      ["3", "1"],
    ]) {
      const x = await setup([headers, ["4", "追加", "", row, col]]);
      await x.preview();
      await h!.value(x.mapping(), NEW_STUDENT);
      await x.confirm();
      await h!.click(h!.button("確認した名簿を反映"));
      expect(x.onChange).not.toHaveBeenCalled();
      expect(h!.container.textContent).toMatch(/同じ座席|重複|通路|配置の外/);
      await h!.close();
      h = undefined;
    }
  });
});
async function setupGuide(state = fixture(), connected = true, sample = false) {
  h = testDom();
  const save = vi.fn(),
    settings = vi.fn();
  const client = { isConnected: () => connected };
  const render = async (next = state) =>
    h!.render(
      <InitialSetupGuide
        state={next}
        client={client as GoogleWorkspaceClient}
        sample={sample}
        busy={false}
        onOpenSettings={settings}
        onSaveLedger={save}
      />,
    );
  await render();
  return {
    state,
    render,
    save,
    settings,
    roster: () => h!.input("対象クラスの人数"),
    seats: () => h!.input("座席・未配置者"),
  };
}
describe("PF initial setup guide DOM execution", () => {
  it("PF-S031 requires ordered reviews and folder then explicit save; does not claim success", async () => {
    const x = await setupGuide();
    expect((x.seats() as HTMLInputElement).disabled).toBe(true);
    expect(h!.button("確認した設定をSheets").disabled).toBe(true);
    await h!.click(x.roster());
    expect((x.seats() as HTMLInputElement).disabled).toBe(false);
    await h!.click(x.seats());
    expect(h!.button("確認した設定をSheets").disabled).toBe(true);
    expect(x.save).not.toHaveBeenCalled();
    await x.render({
      ...x.state,
      settings: { ...x.state.settings, folderId: "folder" },
    });
    expect(h!.button("確認した設定をSheets").disabled).toBe(false);
    await h!.click(h!.button("確認した設定をSheets"));
    expect(x.save).toHaveBeenCalledOnce();
    expect(h!.container.textContent).not.toContain("保存しました");
  });
  it("PF-S032 changing roster invalidates both reviews and changing seat invalidates seat review", async () => {
    const x = await setupGuide();
    await h!.click(x.roster());
    await h!.click(x.seats());
    await x.render({
      ...x.state,
      students: x.state.students.map((s, i) => (i ? s : { ...s, number: 4 })),
    });
    expect((x.roster() as HTMLInputElement).checked).toBe(false);
    expect((x.seats() as HTMLInputElement).checked).toBe(false);
    await x.render(x.state);
    await x.render({
      ...x.state,
      students: x.state.students.map((s, i) => (i ? s : { ...s, seat: null })),
    });
    expect((x.roster() as HTMLInputElement).checked).toBe(true);
    expect((x.seats() as HTMLInputElement).checked).toBe(false);
  });
  it("PF-S033 zero active invalid duplicate number or disconnected cannot complete setup", async () => {
    for (const kind of ["zero", "invalid", "offline", "sample"]) {
      const state = fixture();
      state.settings!.folderId = "folder";
      if (kind === "zero") state.students = [];
      if (kind === "invalid") state.students[1].number = 1;
      const x = await setupGuide(state, kind !== "offline", kind === "sample");
      if (!(x.roster() as HTMLInputElement).disabled)
        await h!.click(x.roster());
      if (!(x.seats() as HTMLInputElement).disabled) await h!.click(x.seats());
      expect(h!.button("確認した設定をSheets").disabled).toBe(true);
      await h!.click(h!.button("確認した設定をSheets"));
      expect(x.save).not.toHaveBeenCalled();
      await h!.close();
      h = undefined;
    }
  });
});

describe("PF supplemental roster paths", () => {
  it("PF-S003 selected roster tab displays exactly two mapped people, not instruction rows", async () => {
    const x = await setup([
      headers,
      ["1", "青木", "S-A"],
      ["2", "佐藤", "S-B"],
    ]);
    await x.pick();
    await h!.value(h!.input("名簿のシート"), "9");
    await h!.click(h!.button("選んだシートを読み込む"));
    await h!.click(h!.button("この列で対応先を確認"));
    expect(
      h!.container.querySelectorAll('select[aria-label$="行目の対応先"]'),
    ).toHaveLength(2);
    expect(x.mapping(2).value).toBe("S-A");
    expect(x.mapping(3).value).toBe("S-B");
  });
  it("PF-S004 escaped tab responses reach the one-person review", async () => {
    for (const name of ["1'A", "A1"]) {
      const x = await setup();
      x.client.readRosterSheet.mockResolvedValueOnce({
        title: "架空名簿",
        sheetTitle: name,
        values: baseRows,
      });
      await x.preview();
      expect(h!.container.textContent).toContain("架空名簿 / " + name);
      expect(
        h!.container.querySelectorAll('select[aria-label$="行目の対応先"]'),
      ).toHaveLength(1);
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S007 restoring valid columns permits fresh mapping only", async () => {
    const x = await setup();
    await x.read();
    await h!.value(h!.input("氏名"), "0");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(x.mapping()).toBeNull();
    await h!.value(h!.input("氏名"), "1");
    await h!.click(h!.button("この列で対応先を確認"));
    expect(x.mapping().value).toBe("S-A");
  });
  it("PF-S014 long string classroom ID chooses stable identity only after final review", async () => {
    const id = "001234567890123456";
    const x = await setup([headers, ["001", "青木", id]]);
    x.state.students[0].classroomUserId = id;
    await x.render();
    await x.preview();
    expect(x.mapping().value).toBe("S-A");
    expect(h!.container.textContent).toContain(id);
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    expect(x.onChange.mock.calls[0][0].students[0]).toMatchObject({
      id: "S-A",
      number: 1,
      classroomUserId: id,
    });
  });
  it("PF-S016 fullwidth numeral is rejected without rounding", async () => {
    const x = await setup([headers, ["１", "架空"]]);
    await x.preview();
    expect(x.mapping()).toBeNull();
    expect(h!.container.textContent).toContain("整数");
  });
  it("PF-S017 partial row 4 stops entire review then correction preserves rows 2 and 5", async () => {
    const rows = [
      headers,
      ["1", "青木", "S-A"],
      ["", "", "", "", "", "メモ"],
      ["", "佐藤"],
      ["2", "佐藤", "S-B"],
    ];
    const x = await setup(rows);
    await x.preview();
    expect(h!.container.textContent).toContain("4行目");
    expect(x.mapping()).toBeNull();
    rows[3] = [];
    await x.read();
    await h!.click(h!.button("この列で対応先を確認"));
    expect(x.mapping(2).value).toBe("S-A");
    expect(x.mapping(5).value).toBe("S-B");
    expect(
      h!.container.querySelectorAll('select[aria-label$="行目の対応先"]'),
    ).toHaveLength(2);
  });
  it("PF-S018 new unplaced and 1 or 100 seats apply with correct zero-based coordinates", async () => {
    for (const seat of ["", "1", "100"]) {
      const x = await setup([headers, ["4", "追加", "", seat, seat]]);
      x.state.students = x.state.students.map((s) => ({ ...s, seat: null }));
      x.state.seatLayouts = [];
      x.state.settings!.activeSeatLayoutId = undefined;
      await x.render();
      await x.preview();
      await h!.value(x.mapping(), NEW_STUDENT);
      await x.confirm();
      await h!.click(h!.button("確認した名簿を反映"));
      const newStudent = (x.onChange.mock.calls[0][0] as AppState).students.at(
        -1,
      )!;
      expect(newStudent.seat).toEqual(
        seat ? { row: Number(seat) - 1, col: Number(seat) - 1 } : null,
      );
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S020 explicit mapping keeps same-name students separate", async () => {
    const x = await setup([
      headers,
      ["2", "佐藤蓮", "unknown"],
      ["3", "佐藤蓮"],
    ]);
    await x.preview();
    await h!.value(x.mapping(2), "S-B");
    await h!.value(x.mapping(3), "S-C");
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    expect(
      (x.onChange.mock.calls[0][0] as AppState).students.map((s) => s.id),
    ).toEqual(["S-A", "S-B", "S-C"]);
  });
  it("PF-S021 number and name change leave issued tokens and recipient snapshot unchanged", async () => {
    const x = await setup([headers, ["10", "青木新姓", "S-A"]]);
    const before = structuredClone(x.state);
    await x.preview();
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    const next = x.onChange.mock.calls[0][0] as AppState;
    expect(next.students[0]).toMatchObject({
      id: "S-A",
      number: 10,
      name: "青木新姓",
      seat: { row: 0, col: 0 },
    });
    expect(next.collections).toEqual(before.collections);
    expect(next.receipts).toEqual(before.receipts);
    expect(next.events.at(-1)).toMatchObject({
      actor: "teacher-A",
      action: "import_roster_sheets",
    });
  });
  it("PF-S022 stale number seat or saved layout all block old preview", async () => {
    for (const kind of ["number", "seat", "layout"]) {
      const x = await setup();
      await x.preview();
      await x.confirm();
      const next = structuredClone(x.state);
      if (kind === "number") next.students[2].number = 30;
      if (kind === "seat") next.students[2].seat = null;
      if (kind === "layout") next.settings!.activeSeatLayoutId = "different";
      await x.render(next);
      expect(h!.button("確認した名簿を反映").disabled).toBe(true);
      await h!.click(h!.button("確認した名簿を反映"));
      expect(x.onChange).not.toHaveBeenCalled();
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S024 reconnection cannot revive a preview invalidated by account loss", async () => {
    const x = await setup();
    await x.preview();
    await x.confirm();
    x.setAccount(undefined);
    await x.render();
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
    x.setAccount("teacher-A");
    await x.render();
    expect(h!.button("確認した名簿を反映").disabled).toBe(true);
    await x.pick();
    await h!.click(h!.button("選んだシートを読み込む"));
    await h!.click(h!.button("この列で対応先を確認"));
    await x.confirm();
    expect(h!.button("確認した名簿を反映").disabled).toBe(false);
  });
  it("PF-S024 wrong account cannot re-read an A-bound roster", async () => {
    const x = await setup();
    await x.preview();
    x.setAccount("teacher-B");
    await x.render();
    const calls = x.client.readRosterSheet.mock.calls.length;
    await h!.click(h!.button("選んだシートを読み込む"));
    expect(x.client.readRosterSheet).toHaveBeenCalledTimes(calls);
    expect(h!.container.textContent).toContain("異なります");
  });
  it("PF-S025 unconfirmed review survives cancellation with no second metadata read", async () => {
    const x = await setup();
    await x.preview();
    const calls = x.client.readRosterSpreadsheet.mock.calls.length;
    x.client.pickFiles.mockResolvedValueOnce([]);
    await x.pick();
    expect(x.client.readRosterSpreadsheet).toHaveBeenCalledTimes(calls);
    expect(
      (h!.input("人数・氏名・番号・座席と") as HTMLInputElement).checked,
    ).toBe(false);
    expect(x.onChange).not.toHaveBeenCalled();
  });
  it("PF-S026 metadata and removed-tab errors do not select an alternate sheet", async () => {
    for (const error of [
      "選択したシートが削除・変更されています。",
      "通常の表形式の名簿シートがありません。",
      "名簿シートの構成を確認できません。",
    ]) {
      const x = await setup();
      if (error.startsWith("選択")) {
        x.client.readRosterSheet.mockRejectedValueOnce(new Error(error));
        await x.read();
      } else {
        x.client.readRosterSpreadsheet.mockRejectedValueOnce(new Error(error));
        await x.pick();
        expect(x.client.readRosterSheet).not.toHaveBeenCalled();
      }
      expect(h!.container.textContent).toContain(error);
      expect(x.mapping()).toBeNull();
      expect(x.onChange).not.toHaveBeenCalled();
      expect(h!.button("名簿のSheetsを選ぶ").disabled).toBe(false);
      await h!.close();
      h = undefined;
    }
  });
  it("PF-S027 empty/header-only response has retryable error and no review", async () => {
    const x = await setup();
    x.client.readRosterSheet.mockRejectedValueOnce(
      new Error("見出しと1人以上の名簿が必要です。"),
    );
    await x.read();
    expect(h!.container.textContent).toContain("1人以上");
    expect(x.mapping()).toBeNull();
    expect(h!.button("選んだシートを読み込む").disabled).toBe(false);
    expect(x.onChange).not.toHaveBeenCalled();
  });
  it("PF-S028 CSV and Sheets new-plus-existing import differ only in new UUID and audit source", async () => {
    const results: AppState[] = [];
    for (const mode of ["csv", "sheets"]) {
      const x = await setup([
        headers,
        ["1", "青木葵", "S-A"],
        ["4", "追加架空"],
      ]);
      if (mode === "csv")
        await x.csv("出席番号,氏名,生徒ID\n1,青木葵,S-A\n4,追加架空,");
      else await x.preview();
      await h!.value(x.mapping(3), NEW_STUDENT);
      await x.confirm();
      await h!.click(h!.button("確認した名簿を反映"));
      const next = x.onChange.mock.calls[0][0] as AppState;
      expect(next.students).toHaveLength(4);
      expect(next.students.at(-1)!.seat).toBeNull();
      expect(next.students.at(-1)!.id).not.toBe("");
      expect(next.collections).toEqual(x.state.collections);
      results.push(next);
      await h!.close();
      h = undefined;
    }
    const normalize = (s: AppState) =>
      s.students.map((v) => ({ ...v, id: v.number === 4 ? "new-id" : v.id }));
    expect(normalize(results[0])).toEqual(normalize(results[1]));
  });
  it("PF-S030 blank seats allow new person after rejecting occupied/blocked/outside seats", async () => {
    const x = await setup([headers, ["4", "追加", "", "", ""]]);
    await x.preview();
    await h!.value(x.mapping(), NEW_STUDENT);
    await x.confirm();
    await h!.click(h!.button("確認した名簿を反映"));
    expect(
      (x.onChange.mock.calls[0][0] as AppState).students.at(-1)!.seat,
    ).toBeNull();
  });
  it("PF-S032 layout revision and unmount invalidate setup checks", async () => {
    const x = await setupGuide();
    await h!.click(x.roster());
    await h!.click(x.seats());
    await x.render({
      ...x.state,
      settings: { ...x.state.settings, activeSeatLayoutId: "new-version" },
    });
    expect((x.seats() as HTMLInputElement).checked).toBe(false);
    await h!.close();
    h = undefined;
    const y = await setupGuide();
    expect((y.roster() as HTMLInputElement).checked).toBe(false);
    expect((y.seats() as HTMLInputElement).checked).toBe(false);
  });
  it("PF-S033 withdrawn people are not counted as active", async () => {
    const state = fixture();
    state.students = state.students.map((s, i) =>
      i ? { ...s, enrollment: "withdrawn" } : s,
    );
    await setupGuide(state);
    expect(h!.container.textContent).toContain("在籍 1人");
  });
});
