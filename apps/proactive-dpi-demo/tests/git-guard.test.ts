import { test } from "node:test";
import assert from "node:assert/strict";
import { gitGuard } from "../apps/proactive-dpi-be/src/git-guard.ts";

const blocked = (command: string) => gitGuard(command) !== undefined;

// ── what must be blocked ────────────────────────────────────────────────────────────────────────────

const BLOCKED: Record<string, string[]> = {
  push: ["git push", "git push origin incident/inc-0001", "git push --force origin HEAD:main", "git push -u origin HEAD"],
  "merge, pull, rebase": [
    "git merge main",
    "git merge --no-ff incident/inc-0002",
    "git pull",
    "git pull --rebase origin main",
    "git rebase main",
    "git rebase -i HEAD~3",
  ],
  "branch switching": [
    "git switch main",
    "git switch -c other",
    "git switch --detach HEAD~1",
    "git checkout main",
    "git checkout master",
    "git checkout incident/inc-0002",
    "git checkout -",
    "git checkout -b other",
    "git checkout -B other",
    "git checkout -fb other",
    "git checkout --orphan fresh",
    "git checkout --detach",
    "git checkout --det HEAD~1",
    "git checkout --track origin/main",
    "git checkout HEAD~1",
    "git checkout -f main",
    "git checkout --force main",
    "git checkout main --",
    "git bisect start",
  ],
  "reset --hard": [
    "git reset --hard",
    "git reset --hard HEAD~1",
    "git reset --hard origin/main",
    "git reset HEAD~1 --hard",
    "git reset --ha",
    "git reset --hard -- file",
  ],
  "deleting, renaming and force-moving branches": [
    "git branch -d incident/inc-0002",
    "git branch -D incident/inc-0002",
    "git branch --delete incident/inc-0002",
    "git branch --del incident/inc-0002",
    "git branch -m renamed",
    "git branch -M renamed",
    "git branch --move renamed",
    "git branch -f main HEAD",
    "git branch --force main HEAD~1",
    "git branch -fd x",
    "git branch -dr origin/x",
    "git branch -C incident/inc-0001 main",
    "git branch -v -d x",
  ],
  "worktree changes": [
    "git worktree add ../x",
    "git worktree remove ../x",
    "git worktree move a b",
    "git worktree prune",
    "git worktree lock x",
    "git worktree repair",
  ],
  "writing refs directly": [
    "git update-ref refs/heads/main HEAD",
    "git update-ref -d refs/heads/main",
    "git symbolic-ref HEAD refs/heads/main",
    "git symbolic-ref -m moving HEAD refs/heads/main",
    "git symbolic-ref -d HEAD",
    "git fetch . HEAD:main",
    "git fetch origin +refs/heads/*:refs/heads/*",
    "git stash branch other",
    "git reflog expire --expire=now --all",
    "git reflog delete HEAD@{1}",
    "git filter-branch --all",
    "git replace a b",
  ],
  "git global options before the subcommand": [
    "git -C .. push",
    "git -C ../.. checkout main",
    "git -c user.name=x push",
    "git -c core.pager=cat -C .. merge main",
    "git --no-pager push",
    "git --git-dir=../.git push",
    "git --git-dir ../.git push",
    "git --work-tree=. --git-dir=../.git switch main",
    "git --namespace x --no-pager rebase main",
    "git -p -P --bare push",
    "git -C a -C b -c x=y --paginate branch -D z",
  ],
  "git aliases and look-alike subcommands": [
    "git p",
    "git -c alias.x=push x",
    "git -c alias.x='!git push' status",
    "git --config-env=alias.x=Y x",
    "git config alias.p push",
    "git config --global alias.m merge",
    "git config --add ALIAS.x push",
    "git pusH",
    "git push2",
    "git {push,status}",
    "git rebase",
  ],
  "chaining, pipes, subshells, groups": [
    "cd .. && git push",
    "npm test; git push origin HEAD",
    "git status || git merge main",
    "echo done | git rebase main",
    "git status & git push",
    "git status\ngit push",
    "git status;\n\n  git push",
    "(git push)",
    "( cd .. ; git push )",
    "{ git push; }",
    "if true; then git push; fi",
    "while :; do git push; done",
    "for b in a b; do git branch -D $b; done",
    "true && (git merge main)",
    "git status && { git checkout main; }",
    "f() { git push; }; f",
    "case x in x) git push;; esac",
    "git log --oneline 2>&1 | head -1; git push 2>&1",
    "git push >/dev/null",
    "git push 2>/dev/null",
    "git status |& git push",
    "git push &>/dev/null",
    "git push < /dev/null",
    "git push # a comment",
  ],
  "env, command and other prefixes": [
    "GIT_TERMINAL_PROMPT=0 git push",
    "A=1 B=2 git push",
    "env git push",
    "env -i git push",
    "env FOO=1 BAR=2 git push",
    "env -u HOME git merge main",
    "env -S 'git push'",
    "exec -a x git push",
    "ionice -c3 git push",
    "busybox sh -c 'git push'",
    "git --exec-path push",
    "command git push",
    "command -p git push",
    "exec git push",
    "builtin command git push",
    "nohup git push",
    "nice -n 10 git push",
    "timeout 60 git push",
    "timeout -s KILL 5 git push",
    "time git push",
    "sudo git push",
    "sudo -u root git push",
    "sudo -E env GIT_DIR=x git push",
    "doas git push",
    "stdbuf -oL git push",
    "setsid git push",
    "/usr/bin/git push",
    "/usr/local/bin/git -C .. push",
    "./git push",
    "\\git push",
    "'git' push",
    '"git" "push"',
    "g'i't push",
    "gi\\t push",
    "git 'push'",
    "git pu''sh",
    "git \"merge\" main",
  ],
  "xargs, find and parallel": [
    "echo x | xargs git push",
    "echo x | xargs -n1 git push",
    "echo origin | xargs -I{} git push {}",
    "printf 'a\\nb' | xargs -I {} git branch -D {}",
    "find . -maxdepth 0 -exec git push \\;",
    "find . -execdir git merge main \\;",
    "ls | parallel git push",
    "echo push | xargs git",
    "echo push | xargs -I{} git {}",
    "echo origin | xargs sh -c 'git push'",
  ],
  "shells and eval": [
    'bash -c "git push"',
    "bash -c 'git push origin HEAD'",
    "sh -c 'cd .. && git merge main'",
    "zsh -c 'git push'",
    "dash -ec 'git push'",
    "bash -lc 'git push'",
    "bash --login -c 'git push'",
    'sh -c "sh -c \'git push\'"',
    'sh -c "bash -c \\"git push\\""',
    "env bash -c 'git push'",
    "sudo sh -c 'git push'",
    "su -c 'git push'",
    "timeout 5 bash -c 'git push'",
    "eval git push",
    "eval 'git push'",
    "eval 'git' 'push'",
    'eval "cd .. && git push"',
    "watch 'git push'",
    "xargs -I{} sh -c 'git push {}'",
  ],
  "command substitution, backticks and process substitution": [
    "echo $(git push)",
    "echo `git push`",
    'echo "$(git push)"',
    'echo "`git push`"',
    "X=$(git push)",
    "export X=$(git merge main)",
    "git commit -m \"$(git push)\"",
    "cat <(git push)",
    "diff <(git log) >(git push)",
    "ls $(git rebase main)",
    "echo $(echo $(git push))",
    "echo ${X:-$(git push)}",
    'echo "${X:-$(git push)}"',
    "echo $((1 + $(git push; echo 1)))",
    "> $(git push)",
  ],
  "commands built from expansions (cannot be checked, so refused)": [
    "$GIT push",
    "g=git; $g push",
    "G=git; ${G} push",
    '"$GIT" push',
    "$(echo git) push",
    "`echo git` push",
    "git $SUB",
    "git${IFS}push",
    "git -C \"$DIR\" push",
    'git "$@"',
    "git $(echo push)",
    "git -C .. $(echo push)",
    "git ${X}ush origin",
    'sh -c "$(cat script.sh)"',
    'bash -c "$CMD"',
    'eval "$CMD"',
    "eval $(cat x)",
    "echo git push | bash",
    "echo 'git push' | sh",
    "bash <<< 'git push'",
    "bash <<EOF\ngit push\nEOF",
    "sh -s < script.sh",
    "bash",
    "git checkout $BRANCH",
    "git branch $FLAG x",
    "git reset $MODE HEAD",
    "git config $KEY push",
    "git worktree $X",
    "git -c alias.$X=push status",
    "g'i't $(echo push)",
    "$'\\x67it' push",
  ],
};

for (const [group, commands] of Object.entries(BLOCKED))
  for (const command of commands)
    test(`blocks (${group}): ${JSON.stringify(command)}`, () => {
      const reason = gitGuard(command);
      assert.ok(reason, "expected a block");
      assert.ok(reason.length > 10, "the reason is a sentence the agent can act on");
    });

// ── what must keep working ──────────────────────────────────────────────────────────────────────────

const ALLOWED = [
  "git status",
  "git status --short --branch",
  "git log --oneline -5",
  "git log main..HEAD --format=%h",
  "git show 1a2b3c4",
  "git show HEAD --stat",
  "git show HEAD:src/pricing/loyalty.ts",
  "git diff",
  "git diff main...HEAD",
  "git diff --stat HEAD~1",
  "git add -A",
  "git add src/pricing/loyalty.ts test/guest.test.ts",
  'git commit -m "fix(pricing): guests have no loyalty (INC-0001)"',
  "git commit --amend --no-edit",
  "git commit -am 'x'",
  "git checkout -- src/pricing/loyalty.ts",
  "git checkout -- .",
  "git checkout HEAD -- src/pricing/loyalty.ts",
  "git checkout main -- src/pricing/loyalty.ts",
  "git checkout -p -- src/x.ts",
  "git checkout --ours -- src/x.ts",
  "git checkout",
  "git restore src/pricing/loyalty.ts",
  "git restore --staged src/x.ts",
  "git restore --source=HEAD~1 src/x.ts",
  "git branch",
  "git branch -a",
  "git branch -v",
  "git branch -vv",
  "git branch -r",
  "git branch -l 'incident/*'",
  "git branch --list",
  "git branch --show-current",
  "git branch --contains HEAD",
  "git branch --format='%(refname:short)'",
  "git branch --merged main",
  "git branch --no-merged",
  "git branch -u origin/x",
  "git branch new-topic",
  "git branch new-topic HEAD~1",
  "git rev-parse --short HEAD",
  "git rev-parse --abbrev-ref HEAD",
  "git rev-list --count main..HEAD",
  "git symbolic-ref HEAD",
  "git symbolic-ref --short HEAD",
  "git symbolic-ref -q HEAD",
  "git reset HEAD src/x.ts",
  "git reset --soft HEAD~1",
  "git reset --mixed HEAD~1",
  "git reset -- src/x.ts",
  "git stash",
  "git stash push -m wip",
  "git stash pop",
  "git stash list",
  "git blame src/pricing/cart.ts",
  "git ls-files",
  "git grep loyalty",
  "git cherry-pick abc123",
  "git revert HEAD",
  "git tag v1",
  "git remote -v",
  "git config user.name",
  "git config --get core.editor",
  "git config user.name 'Agent'",
  "git fetch",
  "git fetch origin",
  "git merge-base main HEAD",
  "git worktree list",
  "git worktree list --porcelain",
  "git reflog",
  "git reflog show HEAD",
  "git clean -n",
  "git --no-pager log -3",
  "git -C . status",
  "git -c color.ui=never diff",
  "git --git-dir=.git rev-parse HEAD",
  "/usr/bin/git status",
  "GIT_PAGER=cat git log -1",
  "env GIT_PAGER=cat git log -1",
  "git status && git diff | head -20",
  "git log --oneline | head -5",
  "cd src && git status",
  "git status; git log -1",
  "git log -1 2>&1 | cat",
  "git log -1 > /tmp/log.txt",
  "git status 2>/dev/null",
  "git diff --name-only | xargs cat",
  "git diff --name-only | xargs git add",
  "git ls-files -m | xargs -n1 git add",
  "git commit -m \"$(cat msg.txt)\"",
  "git commit -m \"deploy: push the $VERSION fix\"",
  "git log --grep='git push'",
  "git log -S'git merge'",
  "git diff -- 'src/*.ts'",
  "git checkout -- \"$FILE\"",
  "git add \"$FILE\"",
  "echo 'git push is blocked'",
  'echo "git push"',
  "echo git push",
  "echo please do not git-push",
  "grep -rn 'git push' docs",
  "grep -rn git .",
  "grep git push.txt",
  "find . -name '*.ts' | xargs grep -n git",
  "find . -name git",
  "find . -name '*.ts' -exec grep -l loyalty {} \\;",
  "xargs grep -n git",
  "sed -n 1,5p README.md",
  "cat .gitignore",
  "ls -la .git",
  "gitpush",
  "digit push",
  "mygit push",
  "git-push",
  "ghit push",
  "npm test",
  "npm run build",
  "node --test test/guest.test.ts",
  "node --test",
  "ls -la",
  "cat src/pricing/loyalty.ts",
  "rg -n loyalty src",
  "sh script.sh",
  "bash scripts/check.sh --verbose",
  "bash -c 'npm test'",
  "sh -c 'cd src && ls'",
  "bash --version",
  "timeout 60 npm test",
  "time npm test",
  "env NODE_ENV=test npm test",
  "sudo -n true",
  "echo $(date)",
  "echo `date`",
  'echo "$(git status --short)"',
  "X=$(git rev-parse HEAD); echo $X",
  "echo $((1 + 2))",
  "if [ -f a ]; then echo yes; fi",
  "for f in src/*.ts; do echo $f; done",
  "cat <<EOF > notes.txt\nroot cause: guests\nEOF",
  "",
  "   ",
  "# just a comment",
  "true",
];

for (const command of ALLOWED)
  test(`allows: ${JSON.stringify(command)}`, () => {
    assert.equal(gitGuard(command), undefined);
  });

// ── behaviour of the guard itself ───────────────────────────────────────────────────────────────────

test("the reason names what is wrong and, for checkout, how to restore a file instead", () => {
  assert.match(gitGuard("git push")!, /git push is not allowed/);
  assert.match(gitGuard("git checkout main")!, /git restore <file> or git checkout -- <file>/);
  assert.match(gitGuard("git reset --hard")!, /reset --hard/);
  assert.match(gitGuard("git branch -D x")!, /deleting, renaming or force-moving branches/);
  assert.match(gitGuard("git p")!, /alias/);
  assert.match(gitGuard("$G push")!, /shell expansion/);
});

test("a command that is blocked anywhere in a chain blocks the whole chain", () => {
  assert.ok(blocked("git status && git log && git push && git diff"));
  assert.ok(blocked("echo ok; echo ok; git branch -D x"));
});

test("a blocked command inside quotes that only get printed is not run, so it is allowed", () => {
  assert.equal(gitGuard("echo 'x; git push'"), undefined);
  assert.equal(gitGuard('echo "a && git push"'), undefined);
  assert.equal(gitGuard("printf '%s\\n' 'git merge main'"), undefined);
});

test("single quotes hide nothing that runs: $() inside them is text, inside double quotes it runs", () => {
  assert.equal(gitGuard("echo '$(git push)'"), undefined);
  assert.ok(blocked('echo "$(git push)"'));
});

test("line continuations and tabs do not split or hide the subcommand", () => {
  assert.ok(blocked("git \\\n  push"));
  assert.ok(blocked("git\tpush"));
  assert.ok(blocked("git  \t  -C   ..   push"));
  assert.ok(blocked("git\\\n push"));
});

test("a trailing option value is not mistaken for the subcommand", () => {
  assert.ok(blocked("git -C status push"), "`-C status` takes `status` as its path, so the subcommand is push");
  assert.equal(gitGuard("git -C push status"), undefined, "`-C push` is a path, the subcommand is status");
  assert.ok(blocked("git -c push=1 merge main"));
});

test("nesting shells deeper than the limit is refused rather than followed forever", () => {
  let command = "git push";
  for (let i = 0; i < 8; i++) command = `sh -c ${JSON.stringify(command)}`;
  assert.ok(blocked(command));
  let harmless = "ls";
  for (let i = 0; i < 8; i++) harmless = `sh -c ${JSON.stringify(harmless)}`;
  assert.match(gitGuard(harmless)!, /nests shells too deeply/);
});

test("unterminated quotes and substitutions do not throw", () => {
  for (const command of ["echo 'abc", 'echo "abc', "echo $(abc", "echo `abc", "git push 'x", 'git push "x', "$(", "((", "))", "\\"])
    assert.doesNotThrow(() => gitGuard(command), command);
  assert.ok(blocked("git push 'x"));
  assert.ok(blocked("echo $(git push"));
});

test("very long commands are judged quickly", () => {
  const long = Array.from({ length: 2000 }, (_, i) => `git log -${i + 1}`).join(" && ");
  const start = performance.now();
  assert.equal(gitGuard(long), undefined);
  assert.ok(performance.now() - start < 2000);
  assert.ok(blocked(`${long} && git push`));
});

// ── what parsing cannot close ───────────────────────────────────────────────────────────────────────
// These all run today. The guard reads shell syntax; it does not run or analyse programs, and the incident agent can
// write and run programs. They are listed so nobody mistakes the guard for a sandbox. Each of these would need a
// real boundary (a read-only main repo, a git wrapper without write access, no network) rather than more parsing.

const NOT_CLOSED: Record<string, string> = {
  "a script file the agent wrote earlier": "bash push.sh",
  "a script with its own shebang": "./push.sh",
  "node running git itself": "node -e \"require('child_process').execSync('git push')\"",
  "python running git itself": "python3 -c \"import os; os.system('git push')\"",
  "a package script": "npm run deploy",
  "make": "make push",
  "git hooks and filters that run commands": "git commit -m x",
  "writing a ref file by hand into the main repo": "echo abc > ../../.git/refs/heads/main",
  "deleting the main repo's metadata": "rm -rf ../../.git",
  "an alias or function from an earlier call (needs expand_aliases, a function defined in a script)": "mypush",
};

for (const [what, command] of Object.entries(NOT_CLOSED))
  test(`known limit, not closed: ${what}`, () => {
    assert.equal(gitGuard(command), undefined, "if this starts failing the guard got stricter: move it into BLOCKED");
  });
