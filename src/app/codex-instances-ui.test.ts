import { CodexInstance } from "../shared/codex-instances";
import { CodexSortColumn, sortCodexInstances } from "./codex-instances-ui";

const instance = (codexPid: number, extras: Partial<CodexInstance> = {}): CodexInstance => ({
  codexPid, codexStartedAt: "2026-10-20T10:00:00Z", vscodePid: codexPid,
  vscodeStartedAt: "2026-10-20T09:00:00Z", vscodeMainPid: 1, ...extras,
});

test.each<CodexSortColumn>(["title", "workspace", "vscodePid", "codexPid", "lastFileUpdatedAt"])("sorts %s in both directions without changing the snapshot", column => {
  const items = [instance(100, { title: "Window 10", workspace: "d:\\project10", lastFileUpdatedAt: 100 }),
    instance(20, { title: "window 2", workspace: "D:\\project2", lastFileUpdatedAt: 20 })];
  expect(sortCodexInstances(items, column, "ascending").map(item => item.codexPid)).toEqual([20, 100]);
  expect(sortCodexInstances(items, column, "descending").map(item => item.codexPid)).toEqual([100, 20]);
  expect(items.map(item => item.codexPid)).toEqual([100, 20]);
});

test.each<CodexSortColumn>(["title", "workspace", "lastFileUpdatedAt"])("keeps missing %s values last in either direction", column => {
  const items = [instance(1), instance(2, { title: "A", workspace: "D:\\A", lastFileUpdatedAt: 0 }),
    instance(3, { title: "B", workspace: "D:\\B", lastFileUpdatedAt: 100 })];
  expect(sortCodexInstances(items, column, "ascending").map(item => item.codexPid)).toEqual([2, 3, 1]);
  expect(sortCodexInstances(items, column, "descending").map(item => item.codexPid)).toEqual([3, 2, 1]);
});

test("uses a stable PID tie break and treats invalid timestamps as unavailable", () => {
  const items = [instance(3, { lastFileUpdatedAt: NaN }), instance(2, { title: "Same", lastFileUpdatedAt: 1 }),
    instance(1, { title: "Same", lastFileUpdatedAt: 1 })];
  expect(sortCodexInstances(items, "lastFileUpdatedAt", "descending").map(item => item.codexPid)).toEqual([1, 2, 3]);
  expect(sortCodexInstances(items, "title", "ascending").map(item => item.codexPid)).toEqual([1, 2, 3]);
});
