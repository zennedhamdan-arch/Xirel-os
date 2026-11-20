import 'server-only';
import { constants } from 'node:fs';
import { lstat, open, realpath, opendir, link, rename, rm, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const maxFileBytes = 48_000;
const denied = /(^|[._-])(env|secret[s]?|credentials?|tokens?|private|id_rsa)([._-]|$)|\.(pem|key|p12|pfx)$/i;
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage']);
export function validComponent(part: string) {
  return /^[a-z0-9_@\[(][a-z0-9._ @()[\]-]{0,119}$/i.test(part) && !ignored.has(part.toLowerCase()) && !denied.test(part);
}
export function validateProjectPath(path: string): string[] {
  const parts = path.split('/');
  if (path.length > 400 || parts.length > 16 || !parts.every(validComponent)) throw new Error('Path is not an allowed project path');
  return parts;
}

export function projectScope(workspaceId?: string, projectId?: string | null) {
  const root = process.env.AGENT_EXEC_ROOT;
  return workspaceId && projectId && workspaceId === process.env.AGENT_EXEC_WORKSPACE_ID &&
    projectId === process.env.AGENT_EXEC_PROJECT_ID && root && isAbsolute(root) ? root : null;
}

export async function assertProjectRoot(root: string) {
  const absolute = resolve(root);
  if (absolute === '/' || await realpath(absolute) !== absolute || !(await lstat(absolute)).isDirectory()) throw new Error('Invalid project root');
  const info = await stat(absolute);
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Project root must be private and owned by the worker');
  return absolute;
}

async function pathFor(root: string, path: string, allowMissing = false) {
  const parts = validateProjectPath(path);
  let current = await assertProjectRoot(root);
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT' && allowMissing && i === parts.length - 1) return null; throw e; });
    if (info && (info.isSymbolicLink() || (i < parts.length - 1 && (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)))) throw new Error('Path cannot use links or non-directory ancestors');
  }
  return current;
}

export async function inspectProject(root: string, path?: string) {
  const dir = path ? await pathFor(root, path) : await assertProjectRoot(root);
  const candidates: { name: string; type: 'directory' | 'file' }[] = [];
  let inspected = 0;
  for await (const item of await opendir(dir)) {
    if (++inspected > 1000 || candidates.length >= 150) break;
    if (validComponent(item.name) && (item.isDirectory() || item.isFile())) {
      candidates.push({ name: item.name, type: item.isDirectory() ? 'directory' : 'file' });
    }
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function readProjectFile(root: string, path: string) {
  const file = await open(await pathFor(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxFileBytes) throw new Error('File is not a small standalone regular file');
    const bytes = Buffer.alloc(maxFileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const content = bytes.subarray(0, bytesRead);
    if (bytesRead > maxFileBytes || content.includes(0)) throw new Error('Not a bounded text file');
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content, { stream: false }), sha256: hash(content) };
  } finally { await file.close(); }
}

/** Serialize edits across worker processes. The persistent root is never mounted into the sandbox. */
export async function writeProjectFile(root: string, path: string, edit:
  { kind: 'create'; text: string } | { kind: 'replace'; sha256: string; text: string } |
  { kind: 'patch'; sha256: string; find: string; replace: string }) {
  const base = await assertProjectRoot(root);
  const lock = join(base, '.xirel-write-lock');
  await mkdir(lock, { mode: 0o700 });
  const tmp = join(lock, randomUUID());
  try {
    const destination = await pathFor(base, path, edit.kind === 'create');
    let text: string;
    if (edit.kind === 'create') text = edit.text;
    else {
      const previous = await readProjectFile(base, path);
      if (previous.sha256 !== edit.sha256) throw new Error('File changed; read it again before editing');
      if (edit.kind === 'patch') {
        const i = previous.text.indexOf(edit.find);
        if (!edit.find || i < 0 || previous.text.indexOf(edit.find, i + 1) !== -1) throw new Error('Patch context must match exactly once');
        text = previous.text.slice(0, i) + edit.replace + previous.text.slice(i + edit.find.length);
      } else text = edit.text;
    }
    const bytes = Buffer.from(text);
    if (bytes.length > maxFileBytes || bytes.includes(0)) throw new Error('Not a bounded text file');
    const fd = await open(tmp, 'wx', 0o600);
    try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
    if (edit.kind === 'create') { await link(tmp, destination); await rm(tmp); }
    else await rename(tmp, destination);
    return { path, sha256: hash(bytes), bytes: bytes.length };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
