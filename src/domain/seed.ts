import type { AppState, Student } from "./types";

// Fictional people only. The duplicate display name deliberately exercises identity by ID.
const NAMES = [
  "青木 陽菜",
  "佐藤 葵",
  "石井 悠真",
  "伊藤 結衣",
  "井上 蒼",
  "上田 莉子",
  "遠藤 湊",
  "大野 美月",
  "岡田 蓮",
  "小川 陽葵",
  "加藤 樹",
  "木村 彩葉",
  "小林 大和",
  "近藤 凛",
  "斎藤 陽翔",
  "坂本 心春",
  "佐藤 葵",
  "清水 颯太",
  "鈴木 紬",
  "高橋 朝陽",
  "田中 咲良",
  "千葉 悠人",
  "辻 朱莉",
  "中川 碧",
  "中島 結菜",
  "中村 陸",
  "西村 花音",
  "野口 晴",
  "橋本 愛莉",
  "林 一颯",
  "平野 美桜",
  "藤田 瑛太",
  "松田 心結",
  "三浦 新",
  "宮崎 花",
  "村上 奏太",
  "森 七海",
  "山口 旭",
  "山田 琴音",
  "渡辺 理人",
];

export function createInitialState(): AppState {
  const students: Student[] = NAMES.map((name, index) => ({
    id: `demo-student-${String(index + 1).padStart(2, "0")}`,
    name,
    number: index + 1,
    seat: { row: Math.floor(index / 5), col: index % 5 },
  }));
  return {
    schemaVersion: 1,
    className: "2年A組",
    students,
    collections: [],
    receipts: [],
    batches: [],
    events: [],
  };
}
