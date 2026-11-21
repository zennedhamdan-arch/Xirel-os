import type { StudioChange } from './types';

/** Unified full-file hunk. Saves all changed lines, including line-ending-only edits. */
export function studioDiff(change: StudioChange) {
  const lines = (text: string) => text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(change.before), after = lines(change.after);
  const emit = (line: string, prefix: string) => prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  const count = (n: number) => n === 0 ? '0,0' : `1,${n}`;
  return `--- a/${change.path}\n+++ b/${change.path}\n@@ -${count(before.length)} +${count(after.length)} @@\n` +
    before.map(line => emit(line, '-')).join('') + after.map(line => emit(line, '+')).join('');
}
