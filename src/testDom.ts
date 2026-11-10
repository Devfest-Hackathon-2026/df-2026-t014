import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
/** Local DOM harness; no real browser, Google SDK or network is started. */
export function testDom() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://paperflow.test" },
  );
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "Event",
    "MouseEvent",
    "MutationObserver",
  ] as const)
    vi.stubGlobal(
      key,
      key === "window"
        ? dom.window
        : (dom.window as unknown as Record<string, unknown>)[key],
    );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = dom.window.document.getElementById("root")!;
  let root: Root | undefined = createRoot(container);
  const render = async (node: ReactNode) => {
    await act(async () => {
      root!.render(node);
    });
  };
  const click = async (element: Element) => {
    await act(async () => {
      (element as HTMLElement).click();
    });
  };
  const value = async (
    element: HTMLInputElement | HTMLSelectElement,
    next: string,
  ) => {
    await act(async () => {
      const proto =
        element.tagName === "SELECT"
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, next);
      element.dispatchEvent(
        new dom.window.Event(
          element.tagName === "SELECT" ? "change" : "input",
          { bubbles: true },
        ),
      );
      if (element.tagName !== "SELECT")
        element.dispatchEvent(
          new dom.window.Event("change", { bubbles: true }),
        );
    });
  };
  const button = (text: string) => {
    const el = [...container.querySelectorAll("button")].find((e) =>
      e.textContent?.includes(text),
    );
    if (!el) throw Error("Missing button: " + text);
    return el;
  };
  const input = (label: string) => {
    const el = [...container.querySelectorAll("label")]
      .find((e) => e.textContent?.trim().startsWith(label))
      ?.querySelector("input,select");
    if (!el) throw Error("Missing labelled input: " + label);
    return el as HTMLInputElement | HTMLSelectElement;
  };
  const close = async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = undefined;
    }
    dom.window.close();
    vi.unstubAllGlobals();
  };
  return { dom, container, render, click, value, button, input, close };
}
