import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const gsFiles = ["Code.gs", "Reservation.gs"];
const code = gsFiles
  .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8"))
  .join("\n");

const CORNERS = ["top-right", "top-left", "bottom-right", "bottom-left"];

function readAddonFile(name: string) {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

function addon(
  options: {
    tabs?: number;
    properties?: Map<string, string>;
    headerParagraphs?: string[];
  } = {},
) {
  const properties = options.properties ?? new Map<string, string>();
  const propertyApi = {
    getProperty: (key: string) => properties.get(key) ?? null,
    setProperty: (key: string, value: string) => {
      properties.set(key, value);
      return propertyApi;
    },
  };
  let pageMarginTop = 72;
  const headerParagraphs: Array<Record<string, unknown>> = [];
  const namedRanges: Array<{
    name: string;
    range: unknown;
    getName: () => string;
    remove: () => void;
  }> = [];
  const documentTab: Record<string, unknown> = {};

  function makeParagraph(value: string, inHeader = false) {
    let text = value;
    const textApi = {
      appendText: (extra: string) => {
        text += extra;
        return textApi;
      },
      setFontSize: () => textApi,
      setForegroundColor: () => textApi,
    };
    const paragraph: Record<string, unknown> = {
      _inHeader: inHeader,
      _removed: false,
      getType: () => "PARAGRAPH",
      getText: () => text,
      editAsText: () => textApi,
      setFontSize: () => paragraph,
      setForegroundColor: () => paragraph,
      setItalic: () => paragraph,
      removeFromParent: () => {
        paragraph._removed = true;
        const index = headerParagraphs.indexOf(paragraph);
        if (index >= 0) headerParagraphs.splice(index, 1);
      },
    };
    return paragraph;
  }

  const bodyChildren: Array<Record<string, unknown>> = [];
  bodyChildren.push(makeParagraph("原稿本文"));
  const header: Record<string, unknown> = {
    getParagraphs: () =>
      headerParagraphs.filter((paragraph) => !paragraph._removed),
    appendParagraph: (text: string) => {
      const paragraph = makeParagraph(text, true);
      headerParagraphs.push(paragraph);
      return paragraph;
    },
    removeChild: (element: Record<string, unknown>) => {
      element._removed = true;
    },
  };
  (options.headerParagraphs ?? []).forEach((text) =>
    headerParagraphs.push(makeParagraph(text, true)),
  );

  const body: Record<string, unknown> = {
    getPageWidth: () => 595.28,
    getPageHeight: () => 841.89,
    getMarginTop: () => pageMarginTop,
    setMarginTop: (value: number) => {
      pageMarginTop = value;
    },
    getMarginLeft: () => 72,
    getMarginRight: () => 72,
    getMarginBottom: () => 72,
    getNumChildren: () => bodyChildren.length,
    getChild: (index: number) => bodyChildren[index],
  };

  documentTab.getBody = () => body;
  documentTab.getHeader = () =>
    headerParagraphs.some((paragraph) => !paragraph._removed)
      ? header
      : null;
  documentTab.addHeader = () => header;
  documentTab.getNamedRanges = () => [...namedRanges];
  documentTab.addNamedRange = (name: string, range: unknown) => {
    const named = {
      name,
      range,
      getName: () => name,
      remove: () => {
        const index = namedRanges.indexOf(named);
        if (index >= 0) namedRanges.splice(index, 1);
      },
    };
    namedRanges.push(named);
    return named;
  };
  documentTab.newRange = () => {
    const elements: Array<Record<string, unknown>> = [];
    const builder = {
      addElement: (element: Record<string, unknown>) => {
        // Docsの名前付き範囲はヘッダー要素をアンカーにできない。
        if (element._inHeader) throw new Error("header elements are not supported");
        elements.push(element);
        return builder;
      },
      build: () => ({ elements }),
    };
    return builder;
  };

  const doc = {
    getId: () => "current-doc-id",
    getName: () => "同意書",
    getTabs: () =>
      Array.from({ length: options.tabs ?? 1 }, () => ({
        getChildTabs: () => [],
        asDocumentTab: () => documentTab,
      })),
  };

  const blobs: Array<{ bytes: number[] }> = [];
  function makeBlob(data: number[] | Uint8Array | string) {
    const bytes =
      typeof data === "string"
        ? Array.from(Buffer.from(data, "utf8"))
        : Array.from(data);
    const blob = {
      bytes,
      getBytes: () => bytes,
      getDataAsString: () => Buffer.from(bytes).toString("utf8"),
    };
    blobs.push(blob);
    return blob;
  }

  const context = {
    DocumentApp: {
      getActiveDocument: () => doc,
      Attribute: { BORDER_WIDTH: "BORDER_WIDTH" },
    },
    PropertiesService: {
      getUserProperties: () => propertyApi,
    },
    Utilities: {
      getUuid: () => randomUUID(),
      base64EncodeWebSafe: (bytes: number[] | Uint8Array) =>
        Buffer.from(Array.from(bytes))
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_"),
      base64DecodeWebSafe: (value: string) =>
        Array.from(
          Buffer.from(
            value.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
          ),
        ),
      newBlob: (data: number[] | Uint8Array | string) => makeBlob(data),
    },
  };
  const api = runInNewContext(
    `${code}\n({saveTABANESettings,readTABANESettings_,getTABANESidebarState,reserveTABANEQr,releaseTABANEQr,updateTABANEReservationLabel,getQrReservation_,encodeQrReservationMarker_,decodeQrReservationMarker_,getTABANEReservationState_,sanitizeQrLabel_})`,
    context,
  ) as Record<string, (...args: any[]) => any>;
  return {
    api,
    properties,
    blobs,
    headerParagraphs,
    namedRanges,
    getMarginTop: () => pageMarginTop,
  };
}

describe("Docs add-on sidebar surface", () => {
  it("keeps exactly the three sidebar blocks and removes the old handoff controls", () => {
    const html = readAddonFile("Sidebar.html");
    const headings = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map(
      (match) => match[1],
    );
    expect(headings).toEqual(["QRの予約", "仮の名前", "QRのプレビュー"]);
    expect(html).toContain('id="reservation-state"');
    expect(html).toContain('id="reserve">QRの予約<');
    expect(html).toContain('id="release"');
    expect(html).toContain("予約を解除");
    expect(html).toContain('id="label"');
    expect(html).toContain("30文字まで");
    expect(html).toContain('id="save-label"');
    expect(html).toContain('id="preview-page"');
    expect(html).toContain('id="preview-qr"');
    expect(html).toContain("サンプル");
    expect(html).not.toMatch(/対象クラス|配布物名|回収期限|ページ形式/);
    expect(html).not.toMatch(/QR付きPDF|前回設定|Web画面|Docsアカウント/);
    expect(html).not.toMatch(/openTABANEDialog|Dialog|iframe/);
  });

  it("refreshes the state on open and immediately after reserve, label update, and release", () => {
    const html = readAddonFile("Sidebar.html");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const elements: Record<string, any> = {};
    function element(id: string) {
      if (!elements[id]) {
        elements[id] = {
          id,
          textContent: "",
          className: "",
          value: "",
          disabled: false,
          style: {},
          clientWidth: 0,
          handlers: {},
          addEventListener(name: string, handler: () => void) {
            elements[id].handlers[name] = handler;
          },
        };
      }
      return elements[id];
    }
    ["reservation-state", "message", "label", "save-label"].forEach(element);
    element("corner").value = "top-right";
    element("band").value = "96";

    let success: (value: unknown) => void = () => undefined;
    let failure: (error: unknown) => void = () => undefined;
    let stateCalls = 0;
    const calls: Record<string, any> = {};
    const state: Record<string, any> = {
      defaults: { qrCorner: "top-left", qrBandHeightPt: 120, qrLabel: "既定名" },
      defaultQrBandHeightPt: 96,
      reservation: null,
    };
    const runner = {
      withSuccessHandler: (handler: (value: unknown) => void) => {
        success = handler;
        return runner;
      },
      withFailureHandler: (handler: (error: unknown) => void) => {
        failure = handler;
        return runner;
      },
      getTABANESidebarState: () => {
        stateCalls += 1;
        success(state);
      },
      reserveTABANEQr: (input: Record<string, unknown>) => {
        calls.reserve = input;
        state.reservation = {
          corner: input.corner,
          bandHeightPt: input.bandHeightPt,
          originalTopMarginPt: 72,
          label: input.label,
          marker: "PFQR1_test",
        };
        success({ reservation: state.reservation });
      },
      updateTABANEReservationLabel: (label: string) => {
        calls.label = label;
        state.reservation.label = label;
        success({ reservation: state.reservation });
      },
      releaseTABANEQr: () => {
        calls.release = true;
        state.reservation = null;
        success({ released: true, reservation: null });
      },
    };
    runInNewContext(script!, {
      document: { getElementById: element },
      google: { script: { run: runner } },
    });

    expect(stateCalls).toBe(1);
    expect(elements["reservation-state"].textContent).toContain("未予約");
    expect(elements.corner.value).toBe("top-left");
    expect(elements.band.value).toBe(120);
    expect(elements.label.value).toBe("既定名");
    expect(elements["preview-page"].className).toContain("corner-top-left");
    expect(elements["preview-band"].textContent).toBe(120);
    expect(elements.release.disabled).toBe(true);
    expect(elements["save-label"].disabled).toBe(true);

    elements.corner.value = "bottom-right";
    elements.band.value = "150";
    elements.label.value = "文化祭";
    elements.reserve.handlers.click();
    expect(calls.reserve).toEqual({
      corner: "bottom-right",
      bandHeightPt: 150,
      label: "文化祭",
    });
    expect(stateCalls).toBe(2);
    expect(elements["reservation-state"].textContent).toContain("予約済み");
    expect(elements["reservation-state"].textContent).toContain("右下");
    expect(elements["reservation-state"].textContent).toContain("150pt");
    expect(elements["reservation-state"].textContent).toContain(
      "名前「文化祭」",
    );
    expect(elements.message.textContent).toContain("予約しました");
    expect(elements["preview-page"].className).toContain("corner-bottom-right");

    elements.label.value = "新しい名前";
    elements["save-label"].handlers.click();
    expect(calls.label).toBe("新しい名前");
    expect(stateCalls).toBe(3);
    expect(elements["reservation-state"].textContent).toContain(
      "名前「新しい名前」",
    );
    expect(elements.message.textContent).toContain("名前を反映しました");

    elements.release.handlers.click();
    expect(calls.release).toBe(true);
    expect(stateCalls).toBe(4);
    expect(elements["reservation-state"].textContent).toContain("未予約");
    expect(elements.message.textContent).toContain("解除");

    elements.band.value = "20";
    elements.reserve.handlers.click();
    expect(elements.message.textContent).toContain("48〜180pt");
    expect(elements.message.className).toContain("error");
    expect(failure).toBeTypeOf("function");
  });

  it("requests only the current-document and UI scopes the reservation needs", () => {
    const manifest = JSON.parse(readAddonFile("appsscript.json"));
    expect(manifest.oauthScopes).toEqual([
      "https://www.googleapis.com/auth/documents.currentonly",
      "https://www.googleapis.com/auth/script.container.ui",
    ]);
    expect(readAddonFile("appsscript.json")).not.toContain("userinfo.email");
    expect(code).not.toMatch(/Session\.|getEffectiveUser|getActiveUser/);
  });

  it("removes the legacy web handoff, its URL, and Dialog.html", () => {
    const sources = [
      "Code.gs",
      "Reservation.gs",
      "Sidebar.html",
      "appsscript.json",
      "README.md",
    ].map(readAddonFile);
    const legacyHost = Buffer.from(
      "cXJjaGVja2VyLTUzM2QyLndlYi5hcHA=",
      "base64",
    ).toString("utf8");
    sources.forEach((source) =>
      expect(source).not.toContain(legacyHost),
    );
    expect(code).not.toMatch(
      /PAPERFLOW_DEFAULT_URL|PAPERFLOW_WEB_APP_URL|getTABANEConfiguration|exportCurrentDocumentPdf|checkCurrentDocumentSource|openTABANEDialog|effectiveAccountEmail_/,
    );
    expect(existsSync(new URL("./Dialog.html", import.meta.url))).toBe(false);
    expect(readAddonFile(".claspignore")).not.toContain("Dialog.html");
  });
});

describe("PF QR reservation", () => {
  it("encodes labels as base64url and decodes both new and old marker formats", () => {
    const { api } = addon();
    expect(api.encodeQrReservationMarker_("bottom-left", 120, 72)).toBe(
      "PFQR1_bl_120_72_",
    );
    const labeled = api.encodeQrReservationMarker_(
      "top-right",
      96,
      72,
      "文化祭 ポスター",
    );
    expect(labeled).toMatch(/^PFQR1_tr_96_72_[A-Za-z0-9_-]+$/);
    expect(api.decodeQrReservationMarker_(labeled)).toMatchObject({
      corner: "top-right",
      bandHeightPt: 96,
      originalTopMarginPt: 72,
      label: "文化祭 ポスター",
      marker: labeled,
    });
    expect(api.decodeQrReservationMarker_("PFQR1_bl_120_72")).toMatchObject({
      corner: "bottom-left",
      bandHeightPt: 120,
      originalTopMarginPt: 72,
      label: "",
    });
    expect(api.decodeQrReservationMarker_("PFQR1_bl_120_72_")).toMatchObject({
      label: "",
    });
    expect(api.decodeQrReservationMarker_("PFQR1_xx_120_72")).toBeNull();
    expect(api.decodeQrReservationMarker_("PFQR1_tr_20_72")).toBeNull();
    expect(api.decodeQrReservationMarker_("PFQR1_tr_96_999")).toBeNull();
    expect(() => api.encodeQrReservationMarker_("middle", 96, 72)).toThrow(
      "配置コーナー",
    );
    const longLabel = "あ".repeat(40);
    expect(api.sanitizeQrLabel_(longLabel)).toHaveLength(30);
    expect(
      api.decodeQrReservationMarker_(
        api.encodeQrReservationMarker_("top-left", 96, 72, longLabel),
      ).label,
    ).toHaveLength(30);
  });

  it("reserves with a label, keeps the original margin, and releases exactly", () => {
    const { api, headerParagraphs, namedRanges, getMarginTop } = addon({
      headerParagraphs: ["既存のヘッダー"],
    });
    expect(api.getQrReservation_()).toBeNull();

    const first = api.reserveTABANEQr({
      corner: "top-right",
      bandHeightPt: 96,
      label: "文化祭 ポスター",
    });
    expect(first).toMatchObject({
      corner: "top-right",
      bandHeightPt: 96,
      originalTopMarginPt: 72,
      label: "文化祭 ポスター",
      currentTopMarginPt: 168,
    });
    expect(getMarginTop()).toBe(168);
    expect(namedRanges).toHaveLength(1);
    expect(namedRanges[0].getName()).toBe(first.marker);
    expect(namedRanges[0].getName()).toMatch(/^PFQR1_tr_96_72_[A-Za-z0-9_-]+$/);
    expect(headerParagraphs.map((paragraph) => (paragraph.getText as () => string)())).toEqual([
      "既存のヘッダー",
      expect.stringContaining("ここにQRコードが入ります"),
    ]);
    const firstGuide = (headerParagraphs[1].getText as () => string)();
    expect(firstGuide).toContain("名前「文化祭 ポスター」");
    expect(firstGuide).toContain(first.marker);

    const second = api.reserveTABANEQr({
      corner: "top-left",
      bandHeightPt: 120,
      label: "別の名前",
    });
    expect(second).toMatchObject({
      corner: "top-left",
      bandHeightPt: 120,
      originalTopMarginPt: 72,
      label: "別の名前",
      currentTopMarginPt: 192,
    });
    expect(getMarginTop()).toBe(192);
    expect(namedRanges).toHaveLength(1);
    expect(headerParagraphs).toHaveLength(2);

    const released = api.releaseTABANEQr();
    expect(released.released).toBe(true);
    expect(getMarginTop()).toBe(72);
    expect(api.getQrReservation_()).toBeNull();
    expect(namedRanges).toHaveLength(0);
    expect(headerParagraphs).toHaveLength(1);
    expect(headerParagraphs[0].getText as () => string).toBeTruthy();
    expect((headerParagraphs[0].getText as () => string)()).toBe(
      "既存のヘッダー",
    );

    expect(api.releaseTABANEQr()).toEqual({
      released: false,
      reservation: null,
    });
    expect(getMarginTop()).toBe(72);
  });

  it("updates only the label on an existing reservation", () => {
    const { api, headerParagraphs, namedRanges, getMarginTop } = addon();
    expect(() => api.updateTABANEReservationLabel("名前")).toThrow(
      "QRの予約がありません",
    );
    const first = api.reserveTABANEQr({
      corner: "bottom-right",
      bandHeightPt: 96,
      label: "最初の名前",
    });
    const oldMarker = String(first.marker);
    const updated = api.updateTABANEReservationLabel("新しい 名前");
    expect(updated).toMatchObject({
      corner: "bottom-right",
      bandHeightPt: 96,
      label: "新しい 名前",
    });
    expect(updated.marker).not.toBe(oldMarker);
    expect(getMarginTop()).toBe(168);
    expect(namedRanges).toHaveLength(1);
    expect(namedRanges[0].getName()).toBe(updated.marker);
    const guide = headerParagraphs[0].getText as () => string;
    expect(guide()).toContain("名前「新しい 名前」");
    expect(guide()).not.toContain("最初の名前");
    expect(guide()).toContain(updated.marker);

    const cleared = api.updateTABANEReservationLabel("");
    expect(cleared.label).toBe("");
    expect(namedRanges[0].getName()).toBe(cleared.marker);
    expect(cleared.marker).toMatch(/^PFQR1_br_96_72_$/);
    expect((headerParagraphs[0].getText as () => string)()).not.toContain(
      "名前「",
    );
  });

  it("recovers a labeled reservation from the copied header when the named range is gone", () => {
    const { api, headerParagraphs } = addon();
    api.reserveTABANEQr({
      corner: "bottom-left",
      bandHeightPt: 120,
      label: "文化祭 ポスター",
    });
    expect(headerParagraphs).toHaveLength(1);
    const copiedHeaderText = (headerParagraphs[0].getText as () => string)();
    const copy = addon({ headerParagraphs: [copiedHeaderText] });
    expect(copy.getMarginTop()).toBe(72);
    expect(copy.api.getQrReservation_()).toMatchObject({
      corner: "bottom-left",
      bandHeightPt: 120,
      originalTopMarginPt: 72,
      label: "文化祭 ポスター",
      guideFound: true,
      namedRangeFound: false,
    });
  });

  it("shows presence, corner, band height, and label in the sidebar state", () => {
    const { api } = addon();
    const before = api.getTABANESidebarState();
    expect(before.reservation).toBeNull();
    expect(before.defaultQrBandHeightPt).toBe(96);
    expect(before.defaults).toEqual({});

    api.reserveTABANEQr({
      corner: "top-left",
      bandHeightPt: 120,
      label: "仮の名前",
    });
    expect(api.getTABANESidebarState()).toMatchObject({
      reservation: {
        corner: "top-left",
        bandHeightPt: 120,
        label: "仮の名前",
      },
      defaults: {
        qrCorner: "top-left",
        qrBandHeightPt: 120,
        qrLabel: "仮の名前",
      },
    });

    api.updateTABANEReservationLabel("変更後");
    expect(api.getTABANESidebarState().reservation.label).toBe("変更後");
    api.releaseTABANEQr();
    expect(api.getTABANESidebarState().reservation).toBeNull();
  });

  it("stores only reservation settings and ignores unrelated values", () => {
    const { api, properties } = addon();
    expect(
      api.saveTABANESettings({
        title: "修学旅行",
        className: "2年A組",
        count: 40,
        base64: "secret",
        accessToken: "secret",
        qrCorner: "bottom-left",
        qrBandHeightPt: 120,
        qrLabel: "文化祭",
      }),
    ).toEqual({
      qrCorner: "bottom-left",
      qrBandHeightPt: 120,
      qrLabel: "文化祭",
    });
    expect(api.saveTABANESettings({ qrCorner: "middle", qrBandHeightPt: 20 })).toEqual({
      qrCorner: "bottom-left",
      qrBandHeightPt: 120,
      qrLabel: "文化祭",
    });
    expect(JSON.stringify([...properties])).not.toMatch(
      /secret|修学旅行|2年A組/,
    );
    expect(api.readTABANESettings_()).toEqual({
      qrCorner: "bottom-left",
      qrBandHeightPt: 120,
      qrLabel: "文化祭",
    });
    CORNERS.forEach((corner) => {
      expect(
        api.saveTABANESettings({ qrCorner: corner }).qrCorner,
      ).toBe(corner);
    });
  });
});
