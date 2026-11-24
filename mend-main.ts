// main.ts is mend, the CLI SPEC.md specifies (all ten sections): the command line (1), standard output and
// exit codes (2), files, lines and safe paths (3), format detection (4), the three matching tiers (5),
// unified diffs (6), SEARCH/REPLACE blocks (7), V4A patches (8), the JSON edits (9) and the ordered,
// all-or-nothing write (10). Built on the kit's starter (MIT): sections 1, 3 and 4, the JSON reader of
// section 9 and the tree machinery of section 10 are the starter's, kept as they are; sections 5 to 8,
// and the `R <old> -> <new>` move report of section 2 (the successful move edits of sections 6 and 8
// hand their pair back to the run loop), are written here.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A section 2 exit-2 fault: `error: usage`, `error: no-patch`, `error: format` or `error: parse <N>`. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** A failed edit: one of the section 2 codes plus the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Section 3: a patch's lines, each with one trailing `\r` removed, without the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, has no root, no backslash and no empty/`.`/`..` segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit of a patch. A successful move (section 6 or 8) returns its [old, new] pair for the section 2 `R` line. */
type Edit = (tree: Tree) => [string, string] | undefined;

/** Section 4: the format is the first of the four named tests that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: lines, tiers and the splice that writes the edit's result back to the file
// ---------------------------------------------------------------------------

/** Section 3: a file as (lines, its line break, whether it ended with one). */
interface LM {
  lines: string[];
  br: string;
  final: boolean;
}
function readLM(text: string): LM {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    lines.pop();
  }
  return { lines, br, final };
}
function writeLM(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The three tiers, NRM[0] = exact, NRM[1] = trailing spaces/tabs gone, NRM[2] = leading and trailing gone. */
const NRM: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];
/** Occurrences of old lines O among the file lines at the first tier (under --strict: only tier 0) that has any.
 *  Overlapping occurrences all count. */
function tierOccurrence(lines: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const n = NRM[t];
    const want = O.map(n);
    const pos: number[] = [];
    for (let i = 0; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++)
        if (n(lines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** The first occurrence of O at or after the cursor, at the first tier that has one there; an end-of-file
 *  chunk takes only an occurrence whose lines run to the file's last line. */
function firstAt(lines: string[], O: string[], cursor: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const n = NRM[t];
    const want = O.map(n);
    for (let i = cursor; i + O.length <= lines.length; i++) {
      if (eof && i + O.length - 1 !== lines.length - 1) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++)
        if (n(lines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      if (ok) return { tier: t, pos: i };
    }
  }
  return null;
}

/** One line of a unified hunk or a V4A chunk body: ' ' context, '-' old, '+' new, '\\' a `\` fault line. */
interface BLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
/** Section 5 splice at position `at` (of the `O.length` matched lines): context comes back as the file's own
 *  matched lines, `-` lines drop, `+` lines are written as they are at tiers 0-1 and re-indented at tier 2
 *  (a nonblank line starting with P, the leading spaces/tabs of O's first line, has that P replaced by F, the
 *  leading spaces/tabs of the file's first matched line). */
function spliceEdit(body: BLine[], file: string[], at: number, tier: number): string[] {
  const oFirst = body.find((b) => b.kind === ' ' || b.kind === '-')?.text ?? '';
  const F = (file[at] ?? '').match(/^[ \t]*/)![0];
  const P = oFirst.match(/^[ \t]*/)![0];
  const reind = (s: string): string => (tier === 2 && s.trim() !== '' && (P === '' || s.startsWith(P)) ? F + s.slice(P.length) : s);
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === '\\') continue;
    if (b.kind === '+') {
      out.push(reind(b.text));
      continue;
    }
    if (b.kind === ' ') out.push(file[at + oi] ?? b.text);
    oi += 1;
  }
  return out;
}
/** Replace matched[0..O.length) of lines with the spliced body. */
const replaceAt = (lines: string[], at: number, removed: number, fresh: string[]): string[] =>
  [].concat(lines.slice(0, at), fresh, lines.slice(at + removed));

// ---------------------------------------------------------------------------
// Section 9: the starter's JSON edits
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      return undefined;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      tree.now.set(p, crlf ? (t.slice(0, at) + lf(newStr) + t.slice(at + old.length)).replaceAll('\n', '\r\n') : t.slice(0, at) + lf(newStr) + t.slice(at + old.length));
      return undefined;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      return undefined;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  A: number;
  body: BLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  fromGit: [string | null, string | null];
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** `---`/`+++` path: the text after the four characters, up to the first tab, surrounding spaces removed. */
const PATH4 = (l: string): string => l.slice(4).split('\t')[0]!.trim();
/** A leading `a/` or `b/` is removed (`/dev/null` names no file); either side is accepted. */
const unprefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
const cleanPath = (raw: string): string | null => (raw === '/dev/null' ? null : unprefix(raw));

/** Read the sections. A `diff --git` line or a `--- `/`+++` pair (outside a header) starts one; hunks live in
 *  the section they are under; a hunk header ends any open body and starts a new hunk of the same section. */
function unifiedSections(lines: string[]): Section[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  let inBody = false;
  const newSec = (fromGit: [string | null, string | null]): void => {
    cur = { oldPath: null, newPath: null, fromGit, newFile: false, deleted: false, hunks: [] };
    secs.push(cur);
    inBody = false;
  };
  const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
  const sectionStart = (l: string, i: number): boolean =>
    l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
  /** Blank lines at the very end of an open body are not part of it (an internal blank line is a context line). */
  const closeBody = (): void => {
    const h = cur === null ? null : cur.hunks[cur.hunks.length - 1];
    if (h) while (h.body.length > 0 && h.body[h.body.length - 1]!.kind === ' ' && h.body[h.body.length - 1]!.text === '') h.body.pop();
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (inBody) {
      // The body ends at the first other line; a `diff --git` line, a `--- `/`+++` pair or a `@@` header at that
      // line is then handled below as it deserves (new section, new section, or new hunk of this one).
      if (!sectionStart(l, i) && !l.startsWith('@@') && isBodyLine(l)) {
        const h = cur!.hunks[cur!.hunks.length - 1]!;
        h.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+' | '\\'), text: l === '' ? '' : l.slice(1) });
        continue;
      }
      inBody = false;
      closeBody();
      if (!sectionStart(l, i) && !l.startsWith('@@')) continue;
    }
    if (l.startsWith('diff --git ')) {
      const gm = GIT_RE.exec(l);
      if (gm === null) throw new Exit2(`error: parse ${i + 1}`);
      newSec([cleanPath(gm[1]!), cleanPath(gm[2]!)]);
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.hunks.push({ A: Number(m[1]), body: [] });
      inBody = true;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nxt = lines[i + 1] ?? '';
      if (!nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (!(cur !== null && cur.hunks.length === 0)) newSec([null, null]);
      cur!.oldPath = cleanPath(PATH4(l));
      cur!.newPath = cleanPath(PATH4(nxt));
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.oldPath = cleanPath(l.slice(12).trim());
      else if (l.startsWith('rename to ')) cur.newPath = cleanPath(l.slice(10).trim());
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deleted = true;
      // index, old mode, new mode, similarity/dissimilarity, Index: and any other line: ignored
    }
    // lines outside bodies that are not section headers: ignored (prose, code fences)
  }
  if (inBody) closeBody();
  return secs;
}

/** A `\` line (as in `\ No newline at end of file`) counts only when it follows the body's last context or `+` line. */
const noFinalBreak = (body: BLine[]): boolean =>
  body.length >= 2 && body[body.length - 1]!.kind === '\\' && (body[body.length - 2]!.kind === ' ' || body[body.length - 2]!.kind === '+');

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const op = sec.oldPath ?? sec.fromGit[0]!;
  const np = sec.newPath ?? sec.fromGit[1]!;
  const kind: 'create' | 'delete' | 'move' | 'change' =
    sec.newFile || op === null ? 'create' : sec.deleted || np === null ? 'delete' : op !== np ? 'move' : 'change';
  return (tree) => {
    if (kind === 'create') {
      if (np === null || !safe(np)) throw new Fail('unsafe', np ?? '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let final = plus.length > 0;
      if (noFinalBreak(sec.hunks[sec.hunks.length - 1]!.body)) final = false;
      tree.now.set(np, writeLM(plus, '\n', final));
      return undefined;
    }
    if (!safe(op)) throw new Fail('unsafe', op);
    if (kind === 'move' && np !== null && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (kind === 'move' && np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    if (kind === 'delete') {
      tree.now.set(op, null);
      return undefined;
    }
    const lm = readLM(before);
    let d = 0;
    let final = lm.final;
    for (const h of sec.hunks) {
      const O: string[] = [];
      const N: string[] = [];
      for (const b of h.body) {
        if (b.kind === ' ') {
          O.push(b.text);
          N.push(b.text);
        } else if (b.kind === '-') O.push(b.text);
        else if (b.kind === '+') N.push(b.text);
      }
      const len = lm.lines.length;
      if (O.length === 0) {
        const at = Math.min(h.A + d, len);
        lm.lines.splice(at, 0, ...N);
        if (at === len) final = !noFinalBreak(h.body);
      } else {
        const o = tierOccurrence(lm.lines, O, strict);
        if (o === null) throw new Fail('no-match', op);
        const target = h.A - 1 + d;
        let best = o.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of o.pos)
          if (Math.abs(p - target) < bestDist) {
            best = p;
            bestDist = Math.abs(p - target);
          }
        const reachedEnd = best + O.length === len;
        lm.lines = replaceAt(lm.lines, best, O.length, spliceEdit(h.body, lm.lines, best, o.tier));
        if (reachedEnd) final = !noFinalBreak(h.body);
      }
      d += N.length - O.length;
    }
    const text = writeLM(lm.lines, lm.br, final);
    if (kind === 'move' && np !== null) {
      tree.now.set(np, text);
      tree.now.set(op, null);
      return [op, np];
    }
    tree.now.set(op, text);
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | null = null;
  let lastEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++)
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    let cl = -1;
    if (eq !== -1)
      for (let j = eq + 1; j < lines.length; j++)
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          cl = j;
          break;
        }
    if (eq === -1 || cl === -1) throw new Exit2(`error: parse ${s + 1}`);
    const old = lines.slice(s + 1, eq);
    const add = lines.slice(eq + 1, cl);
    // The path: the nearest non-blank, non-fence line before SEARCH and after the previous block, else the
    // previous block's path, and the first block with none is a parse fault of its SEARCH line.
    let path: string | null = null;
    for (let j = s - 1; j >= lastEnd + 1; j--) {
      const c = lines[j]!;
      if (blank(c)) continue;
      if (c.trim().startsWith('```')) continue;
      path = c.trim();
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLM(add, '\n', add.length > 0));
        return undefined;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const lm = readLM(before);
      const o = tierOccurrence(lm.lines, old, strict);
      if (o === null) throw new Fail('no-match', p);
      if (o.pos.length > 1) throw new Fail('ambiguous', p);
      const body: BLine[] = [...old.map((t) => ({ kind: '-' as const, text: t })), ...add.map((t) => ({ kind: '+' as const, text: t }))];
      lm.lines = replaceAt(lm.lines, o.pos[0]!, old.length, spliceEdit(body, lm.lines, o.pos[0]!, o.tier));
      tree.now.set(p, writeLM(lm.lines, lm.br, lm.final));
      return undefined;
    });
    lastPath = p;
    lastEnd = cl;
    i = cl;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BLine[];
  eof: boolean;
}
interface VSec {
  kind: 'add' | 'delete' | 'update';
  path: string;
  move: string | null;
  lines: string[];
  chunks: VChunk[];
  updLine: number;
  eofSeen: boolean;
}

function v4aSections(lines: string[]): VSec[] {
  const nonblank = lines.map((l, i) => ({ l, i })).filter((x) => !blank(x.l));
  if (nonblank.length === 0) throw new Exit2('error: parse 1');
  if (nonblank[0]!.l.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${nonblank[0]!.i + 1}`);
  const end = nonblank[nonblank.length - 1]!;
  if (end.l.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  let curChunk: VChunk | null = null;
  const chunkTrailBlank = (c: VChunk): boolean => c.body.length > 0 && c.body[c.body.length - 1]!.kind === ' ' && c.body[c.body.length - 1]!.text.trim() === '';
  /** Blank lines at the end of a section (before the next section or `*** End Patch`) are not part of it. */
  const closeChunk = (s: VSec): void => {
    if (s.kind === 'add') while (s.lines.length > 0 && s.lines[s.lines.length - 1]!.trim() === '') s.lines.pop();
    else if (curChunk !== null) while (curChunk.body.length > 0 && chunkTrailBlank(curChunk)) curChunk.body.pop();
    curChunk = null;
  };
  for (let i = nonblank[0]!.i + 1; i < end.i; i++) {
    const l = lines[i]!;
    if (l.startsWith('***') && l.trim() !== '*** End of File') {
      if (cur !== null && cur.kind === 'update' && cur.move === null && cur.chunks.length === 0 && l.startsWith('*** Move to: ')) {
        cur.move = l.slice(13).trim();
        continue;
      }
      if (cur !== null) closeChunk(cur);
      if (l.startsWith('*** Add File: ')) cur = { kind: 'add', path: l.slice(14).trim(), move: null, lines: [], chunks: [], updLine: i + 1, eofSeen: false };
      else if (l.startsWith('*** Delete File: ')) cur = { kind: 'delete', path: l.slice(17).trim(), move: null, lines: [], chunks: [], updLine: i + 1, eofSeen: false };
      else if (l.startsWith('*** Update File: ')) cur = { kind: 'update', path: l.slice(17).trim(), move: null, lines: [], chunks: [], updLine: i + 1, eofSeen: false };
      else throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (blank(l)) cur.lines.push('');
      else if (l.startsWith('+')) cur.lines.push(l.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'delete') {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // an Update File chunk body
    if (l.trim() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
      while (curChunk.body.length > 0 && chunkTrailBlank(curChunk)) curChunk.body.pop();
      curChunk.eof = true;
      curChunk = null;
      // after an end-of-file chunk, body lines would only start a second anchorless chunk: a parse fault
      cur.eofSeen = true;
      continue;
    }
    if (l.startsWith('@@')) {
      if (curChunk !== null) while (curChunk.body.length > 0 && chunkTrailBlank(curChunk)) curChunk.body.pop();
      const anchor = l.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      cur.chunks.push(curChunk);
      continue;
    }
    if (curChunk === null) {
      if (cur.eofSeen) {
        if (blank(l)) continue;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // a body line starts the section's first chunk
      curChunk = { anchor: null, body: [], eof: false };
      cur.chunks.push(curChunk);
    }
    if (blank(l)) curChunk.body.push({ kind: ' ', text: '' });
    else if (l[0] === ' ' || l[0] === '-' || l[0] === '+') curChunk.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
    else throw new Exit2(`error: parse ${i + 1}`);
  }
  if (cur !== null) closeChunk(cur);
  // an Update File with no chunk and no `*** Move to:` is a parse fault of its Update File line
  for (const s of secs) if (s.kind === 'update' && s.chunks.length === 0 && s.move === null) throw new Exit2(`error: parse ${s.updLine}`);
  return secs;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const secs = v4aSections(lines);
  const edits: Edit[] = [];
  for (const s of secs) {
    const p = s.path;
    if (s.kind === 'add') {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLM(s.lines, '\n', s.lines.length > 0));
        return undefined;
      });
      continue;
    }
    if (s.kind === 'delete') {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return undefined;
      });
      continue;
    }
    const np = s.move;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (np !== null && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
      const lm = readLM(before);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          let found = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          outer: for (const t of tiers) {
            const n = NRM[t];
            for (let i2 = cursor; i2 < lm.lines.length; i2++)
              if (n(lm.lines[i2]!) === n(ch.anchor)) {
                found = i2;
                break outer;
              }
          }
          if (found === -1) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        const O: string[] = [];
        const N: string[] = [];
        for (const b of ch.body) {
          if (b.kind === ' ') {
            O.push(b.text);
            N.push(b.text);
          } else if (b.kind === '-') O.push(b.text);
          else if (b.kind === '+') N.push(b.text);
        }
        if (O.length === 0) {
          const at = ch.eof ? lm.lines.length : cursor;
          lm.lines.splice(at, 0, ...N);
          cursor = at + N.length;
        } else {
          const o = firstAt(lm.lines, O, cursor, strict, ch.eof);
          if (o === null) throw new Fail('no-match', p);
          lm.lines = replaceAt(lm.lines, o.pos, O.length, spliceEdit(ch.body, lm.lines, o.pos, o.tier));
          cursor = o.pos + N.length;
        }
      }
      const text = writeLM(lm.lines, lm.br, lm.final);
      if (np !== null) {
        tree.now.set(np, text);
        tree.now.set(p, null);
        return [p, np];
      }
      tree.now.set(p, text);
      return undefined;
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// The run loop: sections 1, 2 and 10
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedSections(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Section 10: the edits apply in order to what the earlier ones left; a failed one changes nothing; if any
  // failed, nothing is written (exit 1) and every failure is reported, in order.
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Section 2's report: one line per changed state, in byte order of the paths, and a successful move is one
  // `R <old> -> <new>` line that replaces that pair's D and A lines, sorted by the new path.
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Set(moves.map((m) => m[0]));
  const movedNew = new Set(moves.map((m) => m[1]));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedOld.has(p) && !movedNew.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [o, n] of moves) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
