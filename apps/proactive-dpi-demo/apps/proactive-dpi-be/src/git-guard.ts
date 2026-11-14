// The incident guard: decides whether a bash command may run in an incident worktree.
//
// It reads the command the way a shell would: quotes, escapes, `;` `&&` `||` `|` `&`, newlines, subshells and
// command substitutions split it into simple commands. Each simple command is unwrapped from assignments, `env`,
// `command`, `sudo`, `xargs`, `sh -c` and friends until a `git` invocation shows up. The invocation is parsed
// (global options such as `-C <path>` and `-c k=v` come first, then the subcommand) and judged by subcommand.
//
// This is a seatbelt for a well-meaning model, not a sandbox. It cannot see inside anything it does not parse:
// a script file, `node -e`, `python -c`, a test file the agent writes and runs, `make` or `npm run` targets, a
// shell alias or function defined in an earlier tool call, or a direct write into the main repo's `.git`.

type Word = { text: string; dynamic: boolean; redir: boolean };

/** Returns why the command is blocked, or undefined when it may run. */
export function gitGuard(command: string): string | undefined {
  return check(command, 0);
}

const MAX_DEPTH = 5;

function check(source: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return "the command nests shells too deeply to check";
  const commands: Word[][] = [];
  parse(source, commands);
  for (const words of commands) {
    const reason = checkSimple(
      words.filter((w) => !w.redir),
      depth,
      false,
    );
    if (reason) return reason;
  }
  return undefined;
}

// ── reading the shell ───────────────────────────────────────────────────────────────────────────────

/** Index of the `)` that closes a `$(` whose contents start at `from`. */
function matchParen(src: string, from: number): number {
  let depth = 1;
  for (let k = from; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") k++;
    else if (c === "'") {
      const j = src.indexOf("'", k + 1);
      if (j < 0) return src.length;
      k = j;
    } else if (c === '"') {
      for (k++; k < src.length && src[k] !== '"'; k++) if (src[k] === "\\") k++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k;
  }
  return src.length;
}

/** Index of the backtick that closes a backtick substitution whose contents start at `from`. */
function matchTick(src: string, from: number): number {
  for (let k = from; k < src.length; k++) {
    if (src[k] === "\\") k++;
    else if (src[k] === "`") return k;
  }
  return src.length;
}

/**
 * Splits `src` into simple commands (appended to `out`) made of words with quotes and escapes resolved. A word is
 * `dynamic` when part of it comes from an expansion the guard cannot evaluate. Command substitutions and
 * subshells are parsed into `out` as commands of their own. Redirection targets are flagged so rules ignore them.
 */
function parse(src: string, out: Word[][]): void {
  let command: Word[] = [];
  let text = "";
  let started = false;
  let dynamic = false;
  let redirTarget = false;
  const endWord = () => {
    if (started) command.push({ text, dynamic, redir: redirTarget });
    if (started) redirTarget = false;
    text = "";
    started = false;
    dynamic = false;
  };
  const endCommand = () => {
    endWord();
    redirTarget = false;
    if (command.length) out.push(command);
    command = [];
  };
  const substitute = (inner: string) => {
    parse(inner, out);
    dynamic = true;
    started = true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") i++;
      else if (next !== undefined) {
        text += next;
        started = true;
        i++;
      }
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close < 0 ? src.length : close;
      text += src.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      started = true;
      let k = i + 1;
      for (; k < src.length && src[k] !== '"'; k++) {
        const d = src[k];
        if (d === "\\" && k + 1 < src.length) {
          const n = src[k + 1];
          if (n !== "\n") text += '"\\$`'.includes(n) ? n : `\\${n}`;
          k++;
        } else if (d === "$" && src[k + 1] === "(") {
          const end = matchParen(src, k + 2);
          substitute(src.slice(k + 2, end));
          text += src.slice(k, end + 1);
          k = end;
        } else if (d === "`") {
          const end = matchTick(src, k + 1);
          substitute(src.slice(k + 1, end));
          text += src.slice(k, end + 1);
          k = end;
        } else {
          if (d === "$") dynamic = true;
          text += d;
        }
      }
      i = k;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 2);
      substitute(src.slice(i + 2, end));
      text += src.slice(i, end + 1);
      i = end;
    } else if (c === "`") {
      const end = matchTick(src, i + 1);
      substitute(src.slice(i + 1, end));
      text += src.slice(i, end + 1);
      i = end;
    } else if (c === "$") {
      dynamic = true;
      started = true;
      text += c;
    } else if (c === "<" || c === ">") {
      // A leading file descriptor (`2>`) is not a word. `<(` and `>(` are process substitutions: the `(` below
      // opens a command of its own. Anything else is a redirection whose target is not an argument.
      if (started && !dynamic && /^\d+$/.test(text)) {
        text = "";
        started = false;
      }
      endWord();
      while (i + 1 < src.length && "<>&|".includes(src[i + 1])) i++;
      if (src[i + 1] !== "(") redirTarget = true;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "#" && !started) {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
    } else {
      text += c;
      started = true;
    }
  }
  endCommand();
}

// ── judging one simple command ──────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "coproc"]);
const NUMBERISH = /^\d+(\.\d+)?[smhd]?$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Programs that run the rest of their arguments as a command. `strings`: they may also take a script string. */
const WRAPPERS: Record<string, { strings: boolean; stdin?: boolean }> = {
  env: { strings: true },
  command: { strings: false },
  builtin: { strings: false },
  exec: { strings: false },
  eval: { strings: true },
  time: { strings: false },
  nohup: { strings: false },
  nice: { strings: false },
  ionice: { strings: false },
  timeout: { strings: false },
  stdbuf: { strings: false },
  setsid: { strings: false },
  busybox: { strings: false },
  unbuffer: { strings: false },
  chronic: { strings: false },
  strace: { strings: false },
  sudo: { strings: true },
  doas: { strings: true },
  su: { strings: true },
  runuser: { strings: true },
  watch: { strings: true },
  script: { strings: true },
  flock: { strings: true },
  find: { strings: false },
  xargs: { strings: false, stdin: true },
  parallel: { strings: false, stdin: true },
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);

const base = (text: string) => text.slice(text.lastIndexOf("/") + 1);

function checkSimple(words: Word[], depth: number, viaStdin: boolean): string | undefined {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i].text) || KEYWORDS.has(words[i].text))) i++;
  if (i >= words.length) return undefined;
  const head = words[i];
  if (head.dynamic)
    return `the command name ${JSON.stringify(head.text)} comes from a shell expansion, so it cannot be checked`;
  const name = base(head.text);
  const rest = words.slice(i + 1);

  if (name === "git") return checkGit(rest, viaStdin);

  if (SHELLS.has(name)) {
    const c = rest.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
    if (c >= 0) {
      if (rest[c + 1]) return check(rest[c + 1].text, depth + 1);
      return undefined;
    }
    const readsStdin = rest.every((w) => w.text.startsWith("-") && !["--version", "--help", "-h"].includes(w.text));
    if (readsStdin) return `${name} would run a script from stdin, which cannot be checked`;
    return undefined;
  }

  const wrapper = WRAPPERS[name];
  if (wrapper) {
    // The wrapped command is the first word that is not an option, an assignment or a number. A word right after
    // an option may be that option's value or the command itself, so both readings are checked.
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j];
      if (w.text.startsWith("-") || NUMBERISH.test(w.text) || ASSIGNMENT.test(w.text)) continue;
      const reason = checkSimple(rest.slice(j), depth + 1, viaStdin || !!wrapper.stdin);
      if (reason) return reason;
      const afterOption = j > 0 && rest[j - 1].text.startsWith("-");
      if (!afterOption && name !== "find") break;
    }
    if (name === "eval") {
      const reason = check(rest.map((w) => w.text).join(" "), depth + 1);
      if (reason) return reason;
    } else if (wrapper.strings) {
      for (const w of rest) {
        if (!/[\s;&|`$()]/.test(w.text)) continue;
        const reason = check(w.text, depth + 1);
        if (reason) return reason;
      }
    }
  }
  return undefined;
}

/** Git commands that exist. Anything else is probably an alias, and an alias can hide `push`. */
const KNOWN = new Set(
  `add am annotate apply archive blame branch bundle cat-file check-attr check-ignore check-ref-format checkout
   checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects
   describe diff diff-files diff-index diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object
   help init interpret-trailers log ls-files ls-remote ls-tree mailinfo maintenance merge-base merge-file merge-index
   merge-tree mktree mv name-rev notes pack-objects patch-id prune range-diff read-tree reflog remote repack
   request-pull rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref
   sparse-checkout stage stash status submodule symbolic-ref tag unpack-file update-index var verify-commit verify-tag version
   whatchanged worktree write-tree`.split(/\s+/),
);

/** Subcommands that are never allowed, with what to tell the agent. */
const FORBIDDEN: Record<string, string> = {
  push: "git push is not allowed",
  pull: "git pull merges into your branch, which is not allowed",
  merge: "git merge is not allowed",
  rebase: "git rebase is not allowed",
  switch: "switching branches is not allowed",
  bisect: "git bisect moves HEAD off your branch",
  "update-ref": "update-ref moves branches directly, which is not allowed",
  "filter-branch": "rewriting history is not allowed",
  "filter-repo": "rewriting history is not allowed",
  replace: "git replace changes what history means, which is not allowed",
  "fast-import": "fast-import writes branches directly, which is not allowed",
};

/** Subcommands whose arguments decide what they do, so an argument nobody can read is not acceptable. */
const NEEDS_LITERAL_ARGS = new Set(["branch", "checkout", "reset", "stash", "fetch", "symbolic-ref", "worktree", "config", "reflog"]);

const dashed = (t: string) => t.startsWith("-") && t !== "-";

/** `--hard`, or any abbreviation git would accept of an option that is exactly one of `longs`. */
function hasLong(args: string[], ...longs: string[]) {
  return args.some((t) => {
    if (!t.startsWith("--") || t === "--") return false;
    const name = t.slice(2).split("=")[0];
    return name.length >= 2 && longs.some((long) => long.startsWith(name));
  });
}

/** A cluster of short options such as `-fd` that contains one of `letters`. */
const hasShort = (args: string[], letters: string) => args.some((t) => /^-[A-Za-z]+$/.test(t) && [...t.slice(1)].some((ch) => letters.includes(ch)));

function checkGit(args: Word[], viaStdin: boolean): string | undefined {
  // Global options come before the subcommand: `git -C path -c k=v --no-pager <subcommand> ...`.
  let i = 0;
  while (i < args.length && args[i].text.startsWith("-")) {
    const t = args[i].text;
    if (t === "-c" || t === "--config-env") {
      const value = args[i + 1]?.text.toLowerCase() ?? "";
      if (value.startsWith("alias.")) return "setting a git alias on the command line is not allowed";
      i += 2;
    } else if (t.startsWith("--config-env=") && t.slice(13).toLowerCase().startsWith("alias.")) {
      return "setting a git alias on the command line is not allowed";
    } else if (t === "-C" || ["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"].includes(t)) {
      i += 2;
    } else i++;
  }
  const sub = args[i];
  if (!sub) {
    if (viaStdin) return "git is run by xargs or parallel with no subcommand, so what it does cannot be checked";
    return args.some((w) => w.dynamic) ? "git is given arguments from a shell expansion, so they cannot be checked" : undefined;
  }
  if (sub.dynamic) return `the git subcommand ${JSON.stringify(sub.text)} comes from a shell expansion, so it cannot be checked`;

  const name = sub.text;
  const rest = args.slice(i + 1);
  const t = rest.map((w) => w.text);
  if (FORBIDDEN[name]) return FORBIDDEN[name];
  if (!KNOWN.has(name)) return `${JSON.stringify(name)} is not a git command the guard knows (an alias can hide push, merge or a branch switch)`;

  if (NEEDS_LITERAL_ARGS.has(name)) {
    const sep = t.indexOf("--");
    const before = sep < 0 ? rest : rest.slice(0, sep);
    if (before.some((w) => w.dynamic)) return `git ${name} is given arguments from a shell expansion, so they cannot be checked`;
  }

  switch (name) {
    case "worktree":
      return t[0] === "list" ? undefined : "worktree changes are not allowed";
    case "reset":
      return hasLong(t, "hard") ? "git reset --hard is not allowed" : undefined;
    case "checkout": {
      if (hasLong(t, "detach", "orphan") || hasShort(t, "bBd") || t.includes("-t") || hasLong(t, "track"))
        return "creating or switching branches is not allowed";
      const sep = t.indexOf("--");
      if (sep >= 0 && sep < t.length - 1) return undefined; // `git checkout [<tree>] -- <paths>` restores files
      if (t.includes("-")) return "git checkout - switches branches, which is not allowed";
      if (t.some((x) => !dashed(x))) return "git checkout <name> would switch branches. To restore a file use git restore <file> or git checkout -- <file>";
      return undefined;
    }
    case "branch": {
      if (hasLong(t, "delete", "move", "force") || hasShort(t, "dDmMfC"))
        return "deleting, renaming or force-moving branches is not allowed";
      return undefined;
    }
    case "stash":
      return t[0] === "branch" ? "git stash branch creates and switches to a branch, which is not allowed" : undefined;
    case "symbolic-ref": {
      const positional = t.filter((x) => !dashed(x));
      if (positional.length >= 2 || hasLong(t, "delete") || hasShort(t, "d")) return "symbolic-ref writes are not allowed";
      return undefined;
    }
    case "fetch":
      return t.some((x) => x.includes(":")) ? "fetching into a local ref (a refspec with a colon) is not allowed" : undefined;
    case "reflog":
      return t.some((x) => x === "expire" || x === "delete") ? "rewriting the reflog is not allowed" : undefined;
    case "config":
      return t.some((x) => x.toLowerCase().startsWith("alias.")) ? "setting a git alias is not allowed" : undefined;
    default:
      return undefined;
  }
}
