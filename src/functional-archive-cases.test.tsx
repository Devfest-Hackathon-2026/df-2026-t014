// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import ArchivePanel from "./ArchivePanel";
import { testDom } from "./testDom";
import { issued } from "./domain/functional-fixtures";
import type { AppState } from "./domain/types";
import type { GoogleWorkspaceClient } from "./google/client";
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
});
async function mount(
  initial: AppState,
  client?: GoogleWorkspaceClient,
  commitAction?: (s: AppState) => Promise<void>,
) {
  dom = testDom();
  let current = initial;
  const errors: string[] = [];
  const commits = vi.fn(async (next: AppState) => {
    await commitAction?.(next);
    current = next;
  });
  function Harness() {
    const [state, setState] = useState(initial);
    return (
      <ArchivePanel
        state={state}
        client={client}
        busy={false}
        onError={(e) => errors.push(e)}
        onCommit={async (next) => {
          await commits(next);
          setState(next);
        }}
      />
    );
  }
  await dom.render(<Harness />);
  return { state: () => current, errors, commits };
}
async function reason(value: string) {
  await act(async () => {
    const el = dom.container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      dom.dom.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new dom.dom.window.Event("input", { bubbles: true }));
  });
}
const confirmed = () =>
  dom.input("対象の配布物・件数・残すファイルを確認しました");
function fakeClient(mime = "application/pdf") {
  return {
    getIdentity: vi.fn(() => ({
      id: "teacher",
      email: "teacher@example.test",
    })),
    isConnected: vi.fn(() => true),
    getFile: vi.fn(async (fileId: string) => ({
      id: fileId,
      mimeType: mime,
      trashed: false,
    })),
    trashFile: vi.fn(async () => {}),
  };
}
describe("Excel functional ArchivePanel production handlers with Google adapter stub", () => {
  it("PF-F202 school year UI validates limits and preserves settings when invalid", async () => {
    const f = issued(),
      h = await mount(f.state);
    await dom.value(dom.input("現在のクラスの年度"), "1899");
    await dom.click(dom.button("年度表示を保存"));
    expect(h.commits).not.toHaveBeenCalled();
    expect(h.errors.at(-1)).toBeTruthy();
    await dom.value(dom.input("現在のクラスの年度"), "2199");
    await dom.click(dom.button("年度表示を保存"));
    expect(h.state().settings?.schoolYear).toBe("2199");
    expect(dom.container.textContent).toContain("2199年度");
  });
  it("PF-F203 reason and explicit confirmation required; target/action change resets acknowledgement", async () => {
    const f = issued(),
      second = issued({ title: "別課題" }).collection;
    f.state.collections.push(second);
    const h = await mount(f.state);
    const submit = () => dom.button("確認した対象をアーカイブ");
    expect(submit().disabled).toBe(true);
    await dom.click(confirmed());
    expect(submit().disabled).toBe(true);
    await dom.click(submit());
    expect(h.commits).not.toHaveBeenCalled();
    await reason("年度末整理");
    expect(submit().disabled).toBe(false);
    await dom.value(dom.input("対象"), f.collection.id);
    expect((confirmed() as HTMLInputElement).checked).toBe(false);
    expect(submit().disabled).toBe(true);
    await dom.click(confirmed());
    await dom.value(dom.input("操作"), "delete");
    expect((confirmed() as HTMLInputElement).checked).toBe(false);
    expect(h.commits).not.toHaveBeenCalled();
  });
  it("PF-F199 PF-F200 archive and unarchive UI handlers preserve collecting lifecycle and call no Google writes", async () => {
    const f = issued();
    f.state.collections[0].status = "collecting";
    const client = fakeClient(),
      h = await mount(f.state, client as unknown as GoogleWorkspaceClient);
    await reason("年度末保管");
    await dom.click(confirmed());
    await dom.click(dom.button("確認した対象をアーカイブ"));
    expect(h.state().collections[0]).toMatchObject({ status: "collecting" });
    expect(h.state().collections[0].archivedAt).toBeTruthy();
    expect(client.trashFile).not.toHaveBeenCalled();
    expect(client.getFile).not.toHaveBeenCalled();
    await dom.value(dom.input("操作"), "unarchive");
    await dom.click(confirmed());
    await dom.click(dom.button("確認した対象のアーカイブを解除"));
    expect(h.state().collections[0].archivedAt).toBeUndefined();
    expect(h.state().collections[0].status).toBe("collecting");
    expect(client.trashFile).not.toHaveBeenCalled();
  });
  it("PF-F213 non-PDF Drive metadata stops trash and prevents cleanup complete", async () => {
    const f = issued();
    f.collection.printDriveFileId = "NONPDF";
    const client = fakeClient("text/plain"),
      h = await mount(f.state, client as unknown as GoogleWorkspaceClient);
    await reason("整理");
    await dom.value(dom.input("操作"), "delete");
    await dom.click(confirmed());
    await dom.click(dom.button("確認した対象をゴミ箱へ移す"));
    expect(client.getFile).toHaveBeenCalledWith("NONPDF");
    expect(client.trashFile).not.toHaveBeenCalled();
    expect(h.state().cleanupOperations?.[0]).toMatchObject({
      status: "failed",
    });
    expect(h.state().cleanupOperations?.[0].files[0].error).toContain(
      "PDFではない",
    );
    expect(h.state().collections[0].deletedAt).toBeUndefined();
    expect(h.errors.at(-1)).toContain("一部");
  });
  it("PF-F218 double submit while commit pending is locked to one cleanup operation", async () => {
    const f = issued();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = await mount(f.state, undefined, async () => gate);
    await reason("空ファイル整理");
    await dom.value(dom.input("操作"), "delete");
    await dom.click(confirmed());
    const button = dom.button("確認した対象をゴミ箱へ移す");
    await dom.click(button);
    await dom.click(button);
    expect(h.commits).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => {
      release();
      await gate;
    });
    expect(h.state().cleanupOperations).toHaveLength(1);
    expect(h.state().cleanupOperations?.[0].status).toBe("complete");
    expect(
      dom.container.querySelector(
        'select option[value="' + f.collection.id + '"]',
      ),
    ).toBeNull();
  });
});
