import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SeatPanel } from "./SeatPanel";
import { createInitialState } from "./domain/seed";
import type { Student } from "./domain/types";

describe("seat panel distribution preview", () => {
  it("shows the selected corner, matching start student and reversed route", () => {
    const students: Student[] = Array.from({ length: 6 }, (_, index) => ({
      id: `student-${index}`,
      name: String.fromCharCode(65 + index),
      number: index + 1,
      seat: { row: Math.floor(index / 3), col: index % 3 },
    }));
    const state = {
      ...createInitialState(),
      students,
      settings: {
        defaultOrder: "snake" as const,
        defaultStartCorner: "bottom-right" as const,
      },
    };
    const html = renderToStaticMarkup(
      <SeatPanel
        state={state}
        busy={false}
        actor="teacher"
        onChange={() => {}}
        onCollectionChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="配布の開始位置"');
    expect(html).toContain('value="bottom-right" selected=""');
    expect(html).toContain("蛇行・右下から");
    expect(html).toContain("開始: 6番 F");
    expect(html).toContain('x1="250" y1="150" x2="150" y2="150"');
    const reversed = renderToStaticMarkup(
      <SeatPanel
        state={{
          ...state,
          settings: { ...state.settings, defaultReverse: true },
        }}
        busy={false}
        actor="teacher"
        onChange={() => {}}
        onCollectionChange={() => {}}
      />,
    );
    expect(reversed).toContain("開始: 3番 C");
    expect(reversed).toContain("蛇行・右下から・逆順");
  });
});
