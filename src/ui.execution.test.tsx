// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, useState } from "react";
import { Modal } from "./ui";
import { testDom } from "./testDom";
let dom: ReturnType<typeof testDom>;
afterEach(async () => {
  await dom?.close();
});
it("PF-G028 nested preview and source dialogs trap focus only in the top modal and restore focus in order", async () => {
  dom = testDom();
  const errors: unknown[] = [];
  dom.dom.window.addEventListener("error", (event) => {
    errors.push(event.error);
    event.preventDefault();
  });
  const closed: string[] = [];
  function Harness() {
    const [first, setFirst] = useState(false),
      [second, setSecond] = useState(false);
    return (
      <>
        <button id="open-first" onClick={() => setFirst(true)}>
          open preview
        </button>
        {first && (
          <Modal
            title="preview"
            onClose={() => {
              closed.push("preview");
              setFirst(false);
            }}
          >
            <button id="open-second" onClick={() => setSecond(true)}>
              open source
            </button>
          </Modal>
        )}
        {second && (
          <Modal
            title="source"
            onClose={() => {
              closed.push("source");
              setSecond(false);
            }}
          >
            <button id="source-last">last source</button>
          </Modal>
        )}
      </>
    );
  }
  await dom.render(<Harness />);
  const initial = dom.container.querySelector(
    "#open-first",
  ) as HTMLButtonElement;
  initial.focus();
  await dom.click(initial);
  expect(dom.dom.window.document.activeElement).toBe(
    dom.container.querySelector('[aria-label="preview"]'),
  );
  await dom.click(dom.container.querySelector("#open-second")!);
  expect(errors).toEqual([]);
  expect(dom.dom.window.document.activeElement).toBe(
    dom.container.querySelector('[aria-label="source"]'),
  );
  await act(async () => {
    initial.focus();
  });
  expect(dom.dom.window.document.activeElement).toBe(
    dom.container.querySelector('[aria-label="source"]'),
  );
  await act(async () => {
    dom.dom.window.document.dispatchEvent(
      new dom.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
  });
  expect(closed).toEqual(["source"]);
  expect(dom.container.querySelector('[aria-label="source"]')).toBeNull();
  expect(dom.dom.window.document.activeElement).toBe(
    dom.container.querySelector('[aria-label="preview"]'),
  );
  await act(async () => {
    dom.dom.window.document.dispatchEvent(
      new dom.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
  });
  expect(closed).toEqual(["source", "preview"]);
  expect(dom.dom.window.document.activeElement).toBe(initial);
  expect(errors).toEqual([]);
});
it("PF-G028 top modal wraps Tab and Shift+Tab without invoking underlying Escape listener", async () => {
  dom = testDom();
  Object.defineProperty(
    dom.dom.window.HTMLElement.prototype,
    "getClientRects",
    {
      configurable: true,
      value() {
        return [{ width: 20, height: 20 }];
      },
    },
  );
  const closed: string[] = [];
  function Harness() {
    const [top, setTop] = useState(false);
    return (
      <>
        <Modal title="base" onClose={() => closed.push("base")}>
          <button onClick={() => setTop(true)}>add top</button>
        </Modal>
        {top && (
          <Modal
            title="top"
            onClose={() => {
              closed.push("top");
              setTop(false);
            }}
          >
            <input aria-label="top input" />
            <button id="last">last</button>
          </Modal>
        )}
      </>
    );
  }
  await dom.render(<Harness />);
  await dom.click(dom.button("add top"));
  const first = dom.container.querySelector(
      '[aria-label="top"] button',
    ) as HTMLElement,
    last = dom.container.querySelector("#last") as HTMLElement;
  await act(async () => {
    last.focus();
    last.dispatchEvent(
      new dom.dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(dom.dom.window.document.activeElement).toBe(first);
  await act(async () => {
    first.dispatchEvent(
      new dom.dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(dom.dom.window.document.activeElement).toBe(last);
  await act(async () => {
    last.dispatchEvent(
      new dom.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(closed).toEqual(["top"]);
  expect(dom.container.querySelector('[aria-label="base"]')).not.toBeNull();
});
it("PF-G028 removing background modal does not steal focus and final close restores original opener", async () => {
  dom = testDom();
  function Harness() {
    const [base, setBase] = useState(false),
      [top, setTop] = useState(false);
    return (
      <>
        <button id="opener" onClick={() => setBase(true)}>
          begin
        </button>
        {base && (
          <Modal title="base" onClose={() => setBase(false)}>
            <button onClick={() => setTop(true)}>add top</button>
          </Modal>
        )}
        {top && (
          <Modal title="top" onClose={() => setTop(false)}>
            <button onClick={() => setBase(false)}>remove background</button>
          </Modal>
        )}
      </>
    );
  }
  await dom.render(<Harness />);
  const opener = dom.container.querySelector("#opener") as HTMLElement;
  opener.focus();
  await dom.click(opener);
  await dom.click(dom.button("add top"));
  await dom.click(dom.button("remove background"));
  expect(dom.container.querySelector('[aria-label="base"]')).toBeNull();
  expect(dom.dom.window.document.activeElement).toBe(
    dom.container.querySelector('[aria-label="top"]'),
  );
  await act(async () => {
    dom.dom.window.document.dispatchEvent(
      new dom.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(dom.dom.window.document.activeElement).toBe(opener);
});
