import { afterEach, describe, expect, it, vi } from "vitest";
import { openGooglePicker, pickerOrigin } from "./picker";

function mockPicker(response: unknown) {
  const values: Record<string, unknown> = {};
  let callback: ((value: unknown) => void) | undefined;
  const dispose = vi.fn();
  class View {
    setMimeTypes(v: string) {
      values.mimeType = v;
      return this;
    }
    setIncludeFolders(v: boolean) {
      values.includeFolders = v;
      return this;
    }
    setSelectFolderEnabled(v: boolean) {
      values.folders = v;
      return this;
    }
    setMode() {
      return this;
    }
  }
  class Builder {
    addView() {
      return this;
    }
    setOAuthToken(v: string) {
      values.token = v;
      return this;
    }
    setDeveloperKey(v: string) {
      values.key = v;
      return this;
    }
    setAppId(v: string) {
      values.appId = v;
      return this;
    }
    setOrigin(v: string) {
      values.origin = v;
      return this;
    }
    setTitle() {
      return this;
    }
    setLocale() {
      return this;
    }
    enableFeature() {
      return this;
    }
    setCallback(value: (data: unknown) => void) {
      callback = value;
      return this;
    }
    build() {
      return { dispose, setVisible: () => callback?.(response) };
    }
  }
  vi.stubGlobal("window", {
    location: { origin: "https://paperflow.example", hash: "" },
    google: {
      picker: {
        DocsView: View,
        PickerBuilder: Builder,
        ViewId: { DOCS: "docs", FOLDERS: "folders", SPREADSHEETS: "sheets" },
        DocsViewMode: { LIST: "list" },
        Feature: { MULTISELECT_ENABLED: "multi" },
        Action: { PICKED: "picked", CANCEL: "cancel", ERROR: "error" },
      },
    },
  });
  return { values, dispose };
}
afterEach(() => vi.unstubAllGlobals());
describe("Drive Picker", () => {
  it("uses the Docs host only for its validated embedded bridge", () => {
    const params = new URLSearchParams({
      paperflowBridge: crypto.randomUUID(),
      paperflowParentOrigin: "https://test-script.googleusercontent.com",
      paperflowHostOrigin: "https://docs.google.com",
    });
    const embedded = {
      location: { origin: "https://paperflow.example", hash: `#${params}` },
      parent: {},
    };
    vi.stubGlobal("window", embedded);
    expect(pickerOrigin()).toBe("https://docs.google.com");
    params.set("paperflowHostOrigin", "https://untrusted.example");
    embedded.location.hash = `#${params}`;
    expect(pickerOrigin()).toBe("https://paperflow.example");
  });
  it("requires project configuration without opening a dialog", async () => {
    await expect(
      openGooglePicker({ apiKey: "", appId: "" }, () => "token", {
        kind: "pdf",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
  });
  it("uses the authorized application and only returns matching PDF selections", async () => {
    const { values, dispose } = mockPicker({
      action: "picked",
      docs: [
        {
          id: "pdf-id",
          name: "原稿.pdf",
          mimeType: "application/pdf",
          url: "https://untrusted.example",
        },
      ],
    });
    await expect(
      openGooglePicker(
        { apiKey: "public-key", appId: "123456" },
        () => "memory-token",
        { kind: "pdf" },
      ),
    ).resolves.toEqual([
      { id: "pdf-id", name: "原稿.pdf", mimeType: "application/pdf" },
    ]);
    expect(values).toMatchObject({
      appId: "123456",
      origin: "https://paperflow.example",
      mimeType: "application/pdf",
      folders: false,
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("returns no selection on cancel and rejects unexpected file types", async () => {
    mockPicker({ action: "cancel" });
    await expect(
      openGooglePicker({ apiKey: "key", appId: "123" }, () => "token", {
        kind: "folder",
      }),
    ).resolves.toEqual([]);
    mockPicker({
      action: "picked",
      docs: [{ id: "wrong", name: "wrong", mimeType: "text/plain" }],
    });
    await expect(
      openGooglePicker({ apiKey: "key", appId: "123" }, () => "token", {
        kind: "spreadsheet",
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATA" });
  });
});
