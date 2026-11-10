import type { AppState, ChangeContext, SavedClass, Student } from "./types";
import { validateStudents } from "./logic";
import { changeEvent, requireChangeContext } from "./workflows";

function snapshot(state: AppState): SavedClass {
  return structuredClone({
    id: state.classId ?? "local-class",
    className: state.className,
    students: state.students,
    collections: state.collections,
    receipts: state.receipts,
    batches: state.batches,
    scanSources: state.scanSources,
    events: state.events,
    operations: state.operations,
    artifacts: state.artifacts,
    seatLayouts: state.seatLayouts,
    settings: state.settings,
    cleanupOperations: state.cleanupOperations,
  });
}

export interface ClassWorkspaceInput {
  id: string;
  className: string;
  students?: Student[];
  classroomCourseId?: string;
}
export function switchClassWorkspace(
  state: AppState,
  input: ClassWorkspaceInput,
): AppState {
  if (!input.id.trim() || !input.className.trim())
    throw new Error("クラスのIDと名前を指定してください。");
  const current = snapshot(state);
  if (current.id === input.id) return state;
  const saved = state.savedClasses?.find((item) => item.id === input.id);
  if (!saved && validateStudents(input.students ?? []).length)
    throw new Error("新しいクラスの名簿に不正なID・番号・座席があります。");
  const target: SavedClass = saved ?? {
    id: input.id,
    className: input.className,
    students: structuredClone(input.students ?? []),
    collections: [],
    receipts: [],
    batches: [],
    events: [],
    operations: [],
    artifacts: [],
    seatLayouts: [],
    settings: {
      classroomCourseId: input.classroomCourseId,
      timezone: "Asia/Tokyo",
    },
  };
  const { id, ...fields } = structuredClone(target);
  return {
    ...fields,
    schemaVersion: 1,
    classId: id,
    savedClasses: [...(state.savedClasses ?? [])]
      .filter((item) => item.id !== input.id && item.id !== current.id)
      .concat(current),
  };
}

export function syncClassRoster(
  state: AppState,
  incoming: Student[],
  context: ChangeContext,
): AppState {
  requireChangeContext(context);
  if (validateStudents(incoming).length)
    throw new Error("取り込む名簿のID・仮番号が不正です。");
  const incomingIds = new Set(incoming.map((student) => student.id));
  let nextNumber = Math.max(
    0,
    ...state.students.map((student) => student.number),
  );
  const students = incoming.map<Student>((student) => {
    const existing = state.students.find(
      (old) =>
        old.id === student.id ||
        (!!student.classroomUserId &&
          (old.classroomUserId === student.classroomUserId ||
            old.id === `classroom:${student.classroomUserId}`)),
    );
    return existing
      ? {
          ...existing,
          name: student.name,
          classroomUserId: student.classroomUserId ?? existing.classroomUserId,
          enrollment: "active" as const,
        }
      : {
          ...structuredClone(student),
          number: ++nextNumber,
          seat: null,
          enrollment: "active" as const,
        };
  });
  const retainedIds = new Set(students.map((student) => student.id));
  students.push(
    ...state.students
      .filter((old) => !incomingIds.has(old.id) && !retainedIds.has(old.id))
      .map((old) => ({ ...old, seat: null, enrollment: "withdrawn" as const })),
  );
  return {
    ...state,
    students,
    events: [
      ...state.events,
      changeEvent(
        "sync_roster",
        state.classId ?? "local-class",
        context,
        state.students.map((student) => ({
          id: student.id,
          name: student.name,
          enrollment: student.enrollment,
        })),
        students.map((student) => ({
          id: student.id,
          name: student.name,
          enrollment: student.enrollment,
        })),
      ),
    ],
  };
}
