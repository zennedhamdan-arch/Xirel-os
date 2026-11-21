/** Git ref-name restrictions; keep case, slash and Unicode. Never interpret as a revision expression. */
export function isStudioBranch(value: string) {
  return value.length > 0 && value.length <= 250 && value !== '@' && !value.startsWith('-') && !value.endsWith('.') &&
    !/[\s\x00-\x1f\x7f~^:?*\[\\]/u.test(value) && !value.includes('..') && !value.includes('@{') &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
