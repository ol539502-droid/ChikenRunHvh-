# Prompt for Claude Code CLI: run the HvH round redesign

Paste everything below the line into a fresh Claude Code CLI session.

**Start that session inside psmux**, so OMC's rate-limit auto-resume can find it. In PowerShell:

```powershell
psmux new -s hvh
cd C:\Users\ojatw\ChikenRunHvh-hvh-v2
claude
```

---

You are continuing work on ChikenRunHvh, a browser HvH chicken shooter: a TypeScript monorepo with
`shared/`, `server/` and `client/` (Node + socket.io + Three.js). Your job is to implement an
approved plan with subagent-driven development. Read this whole prompt before doing anything.

## Where things are

- **Worktree:** `C:\Users\ojatw\ChikenRunHvh-hvh-v2`, branch `hvh-v2`. Main checkout:
  `C:\Users\ojatw\ChikenRunHvh` (do not touch it). Upstream:
  github.com/ol539502-droid/ChikenRunHvh-. The owner pushes through their own fork, which is not
  set up as a remote.
- **Plan to execute:** `docs/superpowers/plans/2026-10-18-hvh-round-redesign.md` (13 tasks).
- **Approved design:** `docs/superpowers/specs/2026-10-18-hvh-round-redesign-design.md`. Every
  implementer and reviewer must read both files.
- **Earlier plan** (Tasks 0–14 done; Task 15 cutover still open):
  `docs/superpowers/plans/2026-10-17-hvh-mechanics-recode.md`. Its ledger is
  `.superpowers/sdd/2026-10-17-hvh-mechanics-recode/progress.md`, and it records the rulings
  R1–R42. The new plan's Task 10 supersedes old Task 14.
- **Recent fixes that must stay:**
  - 870024b, 1eb8bea, 8743179: Mirage bot CPU, grid raycast, NaN guards.
  - 0aae3af, 7f9a43f: CommandClock clock correction, so a command backlog drains.
- **Git identity** is repo-local (mazocracks-pixel / mazocracks@gmail.com). Do not change it.

## The owner's rules (binding)

1. **Superpowers is the only orchestrator for this plan.** Use `superpowers:subagent-driven-development`.
   Do not use OMC `/team`, `/autopilot`, `/ralph` or any other OMC execution mode on it.
2. **Use OMC only for rate-limit waiting** (`omc wait`, set up below).
3. **Antigravity is a manual fallback only** (`/ask antigravity`, or `agy -p`). Never use it for
   backend tasks (1–3 and 5–10) or for any review. Its quota may be exhausted; if so, use Claude.
4. **Run backend tasks (1–10) and every review on the strongest model** (`model: opus`). Panel
   tasks 11–13 may use a standard model for the implementer, but their reviews stay on the strongest.
5. **Ask the owner before each install**, of any package, tool or browser. **Stop and report if
   any step fails** (a command error, a failed gate, a review you cannot get approved after two
   fix rounds).
6. **Never push, never commit to `main`.** Commit on `hvh-v2` only. Each commit message ends with
   a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
7. **Do not start the old plan's Task 15 (cutover)** after this plan. Stop and ask.

## Windows environment (read carefully)

- Nodist is broken and is first on PATH. Prefix every node/npm/npx command:
  - Git Bash: `export PATH="/c/Program Files/nodejs:$PATH";`
  - PowerShell: `$env:Path='C:\Program Files\nodejs;'+$env:Path;`
- Global npm packages sit under `C:\Program Files (x86)\Nodist\bin\node_modules`, and their
  launchers do not work. Run them with the official node instead:
  - **OMC:** `node "C:\Program Files (x86)\Nodist\bin\node_modules\oh-my-claude-sisyphus\bridge\cli.cjs" <args>`
  - **Playwright CLI:** `node "C:\Program Files (x86)\Nodist\bin\node_modules\@playwright\cli\playwright-cli.js" <args>`.
    Always pass `--browser=msedge` to `open`; Chrome is not installed.
- Tests use node:test via tsx in `{shared,server,client}/test/**`. Put new v2 tests in `*/test/hvh-v2/`.
  - One file: `npx tsx --test <file>`.
  - Gate: `npm run typecheck` (must exit 0; don't hide its output with `tail`) and `npm test`.
  - Known flaky tests: botchoice, report, phase5, zombie Exploder, and socket tests under CPU load.
    Re-run a flaky file alone before calling it a failure.
  - Do not run the full suite while the balance sweep runs; they fight for CPU.
- **Local dev server** (`npm run dev` hangs here). Run the two parts separately, in the background:
  - Server: `cd server && HVH_ENGINE=v2 DEV_PASSKEY=<passkey> node --import tsx src/index.ts --dev` (port 3000).
    Ask the owner for the dev passkey, or generate a temporary one and tell them.
  - Client: `cd client && node ../node_modules/vite/bin/vite.js` (port 5173).
  - Neither auto-reloads server code; restart the server after server changes. Before starting, kill
    any old process on port 3000; a stale one causes confusing results.

## Step 1: Set up OMC auto start (rate-limit auto-resume)

Do these in order, and report each result in one line:

1. Check that you are inside psmux: `echo $TMUX` (Git Bash) or `$env:TMUX` (PowerShell) must be
   non-empty. If it is empty, stop and tell the owner to restart the session inside psmux, as
   shown above.
2. Check psmux exists: `where.exe psmux`. It is installed via winget at
   `C:\Users\ojatw\AppData\Local\Microsoft\WinGet\Packages\marlocarlo.psmux_Microsoft.Winget.Source_8wekyb3d8bbwe\`.
   If it is missing, **ask before installing** (`winget install psmux`).
3. Status: `omc wait` (through the node path above). It should print the rate-limit status.
4. Enable the auto-resume daemon: `omc wait --start`. Then run `omc wait` again and confirm the
   daemon is on.
5. If any of these fails, stop and report the exact error. Do not try other OMC features to work
   around it.

## Step 2: Execute the plan

1. Invoke `superpowers:subagent-driven-development` with the plan path. Set up its workspace and a
   ledger at `.superpowers/sdd/2026-10-18-hvh-round-redesign/progress.md`, using the skill's
   scripts (`sdd-workspace`, `task-brief`, `review-package`).
2. For each task:
   - Implementer subagent: TDD, then commit.
   - Task review on the strongest model.
   - Fix rounds (resume the same implementer).
   - Scoped re-review.
   - Record rulings in the ledger, continuing from R43.
   - Give every implementer the "Windows environment" section above verbatim.
3. **Task 1:** the implementer must verify the CS:GO weapon numbers against a public CS:GO
   weapon-data source (`items_game` values) and cite it in a code comment. If a value differs
   from the plan, use the verified one and record a ruling.
4. **Task 10 (balance sweep):** run the full sweep in the background and wait for it. Don't poll;
   use OMC wait only if a rate limit hits. If the balance rule cannot be met after reasonable
   tuning, stop and report the tables to the owner instead of loosening the rule.
5. **Task 12:** the manual visual check uses the Playwright CLI and Edge, with the dev server
   running. Save screenshots in your scratchpad and list their paths.
6. After each Part (C: Tasks 1–4; A: 5–8; B: 9; E: 10; D: 11–13), post a short status:
   - the commits
   - the test counts
   - anything that needs the owner
   
   Then continue without waiting, unless rule 5 applies.

## Step 3: Finish

1. Run a whole-branch review on the strongest model for `d4b7846..HEAD`. Fix what it finds, and
   re-review.
2. Run the final gate: `npm run typecheck` (exit 0) and `npm test` (all pass; flaky ones re-run alone).
3. Start the local dev server (both parts) so the owner can play-test at http://localhost:5173.
   Do a quick Playwright smoke test on v2 HvH Mirage:
   - a round starts
   - the buy menu shows two categories
   - no "command flood" verdicts appear over 15 s (count `shotVerdict` reasons in the page)
4. Write a final summary for the owner:
   - what changed per part
   - the full list of rulings you made (R43 onward)
   - the balance results
   - how to play-test
   - what is left: old Task 15 cutover, pushing to their fork
   
   Do not push.
