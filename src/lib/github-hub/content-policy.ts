import 'server-only';

// Defense in depth; sharing still requires manual review of each pinned public file.
export function likelyCredential(value: string) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[pousr]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{15,}|AKIA[A-Z0-9]{16}|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}|sk-[a-z0-9_-]{16,})\b|(?:postgres(?:ql)?|mysql|redis):\/\/[^\s/@]+:[^\s/@]+@|\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization|secret)\b\s*[:=]\s*["']?[a-z0-9+/=_\-]{8,}/i.test(value);
}
