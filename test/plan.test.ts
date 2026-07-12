import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkReadOnlyCommand,
	createPlanState,
	execPlanCheck,
	execPlanDiscard,
	execPlanDone,
	execPlanEdit,
	execPlanEnter,
	execPlanRead,
	execPlanWrite,
	listPlanNames,
	modeDisabledTools,
	PLAN_TOOL_NAMES,
	type PlanState,
	planChecklistState,
	readActivePlan,
	readPlanFile,
	resolveActivePlanPath,
	slugifyPlanName,
} from "../src/core/plan.ts";

const TEST_PLANS_DIR = join(import.meta.dirname, "__test_tmp__", "plans");

/** PlanState rooted in the test dir — mirrors createPlanState's shape without
 * touching the real ~/.cast/plans. */
function testState(sessionId: string): PlanState {
	return { enabled: false, plansDir: join(TEST_PLANS_DIR, sessionId) };
}

describe("plan", () => {
	beforeEach(() => {
		if (existsSync(TEST_PLANS_DIR)) rmSync(TEST_PLANS_DIR, { recursive: true });
		mkdirSync(TEST_PLANS_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_PLANS_DIR)) rmSync(TEST_PLANS_DIR, { recursive: true });
	});

	describe("modeDisabledTools", () => {
		it("plan mode blocks writers and build-only plan tools, never bash", () => {
			const gated = modeDisabledTools(true);
			expect(gated).toContain("write");
			expect(gated).toContain("edit");
			expect(gated).toContain("plan_check");
			expect(gated).toContain("plan_enter");
			// bash stays advertised — the executor's read-only gate handles it
			expect(gated).not.toContain("bash");
			expect(gated).not.toContain("plan_write");
			expect(gated).not.toContain("plan_read");
		});

		it("build mode blocks exactly the authoring tools", () => {
			const gated = modeDisabledTools(false);
			expect([...gated].sort()).toEqual(["plan_discard", "plan_done", "plan_edit", "plan_write"]);
		});

		it("every plan tool has an explicit mode decision (or is dual-mode plan_read)", () => {
			// A new PLAN_TOOL_NAMES entry must be placed in exactly one mode's
			// gate list — or knowingly left dual-mode like plan_read. This test
			// fails the moment someone adds a tool without deciding.
			const planGated = new Set(modeDisabledTools(true).filter((n) => n.startsWith("plan_")));
			const buildGated = new Set(modeDisabledTools(false));
			const dualMode = ["plan_read"];
			for (const name of PLAN_TOOL_NAMES) {
				const decisions = [planGated.has(name), buildGated.has(name), dualMode.includes(name)].filter(
					Boolean,
				).length;
				expect(decisions, `tool ${name} needs exactly one mode decision`).toBe(1);
			}
		});
	});

	describe("createPlanState", () => {
		it("derives a per-session plans directory", () => {
			const state = createPlanState("abc");
			expect(state.plansDir.endsWith(join(".cast", "plans", "abc"))).toBe(true);
			expect(state.enabled).toBe(false);
			expect(state.activePlanPath).toBeUndefined();
		});
	});

	describe("slugifyPlanName", () => {
		it("kebab-cases arbitrary names", () => {
			expect(slugifyPlanName("Auth Refactor!")).toBe("auth-refactor");
			expect(slugifyPlanName("  OAuth2 / PKCE flow  ")).toBe("oauth2-pkce-flow");
		});

		it("neutralizes path traversal", () => {
			expect(slugifyPlanName("../../etc/passwd")).toBe("etc-passwd");
			expect(slugifyPlanName("..")).toBe("");
		});
	});

	describe("checkReadOnlyCommand", () => {
		it("allows inspection pipelines", () => {
			expect(checkReadOnlyCommand("ls -la").ok).toBe(true);
			expect(checkReadOnlyCommand("cat src/app.ts | grep -n handler | head -5").ok).toBe(true);
			expect(checkReadOnlyCommand("git log --oneline -10 && git status").ok).toBe(true);
			expect(checkReadOnlyCommand("git diff HEAD~1 -- src/").ok).toBe(true);
			expect(checkReadOnlyCommand("LC_ALL=C sort file.txt | uniq -c").ok).toBe(true);
		});

		it("rejects anything that can write", () => {
			expect(checkReadOnlyCommand("rm -rf /tmp/x").ok).toBe(false);
			expect(checkReadOnlyCommand("echo hi > out.txt").ok).toBe(false);
			expect(checkReadOnlyCommand("cat $(find_evil)").ok).toBe(false);
			expect(checkReadOnlyCommand("ls `rm -rf .`").ok).toBe(false);
			expect(checkReadOnlyCommand("npm test").ok).toBe(false);
			expect(checkReadOnlyCommand("sed -i 's/a/b/' file").ok).toBe(false);
			expect(checkReadOnlyCommand("git checkout main").ok).toBe(false);
			expect(checkReadOnlyCommand("git branch new-branch").ok).toBe(false);
			expect(checkReadOnlyCommand("ls && touch x").ok).toBe(false);
			expect(checkReadOnlyCommand("find . -name '*.md' | xargs rm").ok).toBe(false);
			expect(checkReadOnlyCommand("").ok).toBe(false);
		});

		it("rejects argument-level writers and executors on allowlisted binaries", () => {
			// find/fd can delete or exec through flags
			expect(checkReadOnlyCommand("find . -name '*.tmp' -delete").ok).toBe(false);
			expect(checkReadOnlyCommand("find . -exec rm {} \\;").ok).toBe(false);
			expect(checkReadOnlyCommand("fd -x rm").ok).toBe(false);
			// output flags write without any `>`
			expect(checkReadOnlyCommand("sort -o out.txt in.txt").ok).toBe(false);
			expect(checkReadOnlyCommand("tree -o out.txt").ok).toBe(false);
			expect(checkReadOnlyCommand("git log --output=/tmp/x").ok).toBe(false);
			expect(checkReadOnlyCommand("git log --output /tmp/x").ok).toBe(false);
			// process substitution executes commands
			expect(checkReadOnlyCommand("diff <(rm -rf x) file").ok).toBe(false);
			// env launches arbitrary binaries
			expect(checkReadOnlyCommand("env sh -c 'rm -rf x'").ok).toBe(false);
			// uniq's second positional argument is an output file
			expect(checkReadOnlyCommand("uniq input.txt output.txt").ok).toBe(false);
			// ...while the plain read-only forms of the same binaries still pass
			expect(checkReadOnlyCommand("find . -name '*.md' -type f").ok).toBe(true);
			expect(checkReadOnlyCommand("sort in.txt | uniq -c").ok).toBe(true);
			expect(checkReadOnlyCommand("git log --oneline").ok).toBe(true);
		});
	});

	describe("planChecklistState", () => {
		it("counts unchecked and checked items", () => {
			const { unchecked, checked } = planChecklistState("## Steps\n- [ ] a\n- [x] b\n- [X] c\n* [ ] d\ntext");
			expect(unchecked).toBe(2);
			expect(checked).toBe(2);
		});

		it("returns zeros for a plan without a checklist", () => {
			expect(planChecklistState("# Plan\nJust prose.")).toEqual({ unchecked: 0, checked: 0 });
		});

		it("ignores checkbox-like lines inside code fences", () => {
			const content = "## Steps\n- [x] real step\n```markdown\n- [ ] example in docs\n```\n- [x] another";
			// Without fence-awareness the fenced example would keep the plan
			// "unfinished" forever (done-variant never triggers).
			expect(planChecklistState(content)).toEqual({ unchecked: 0, checked: 2 });
		});
	});

	describe("readPlanFile", () => {
		it("returns exists=false when file does not exist", () => {
			const result = readPlanFile("/nonexistent/plan.md");
			expect(result.exists).toBe(false);
			expect(result.content).toBe("");
			expect(result.headings).toEqual([]);
		});

		it("returns exists=false for empty file", () => {
			const path = join(TEST_PLANS_DIR, "empty.md");
			writeFileSync(path, "", "utf-8");
			const result = readPlanFile(path);
			expect(result.exists).toBe(false);
		});

		it("reads content and extracts headings", () => {
			const path = join(TEST_PLANS_DIR, "read.md");
			writeFileSync(
				path,
				"# Plan: Test\n\n## Context\nSome context\n\n## Steps\n1. Step one\n2. Step two\n\n## Verification\nRun tests\n",
				"utf-8",
			);
			const result = readPlanFile(path);
			expect(result.exists).toBe(true);
			expect(result.headings).toEqual(["Plan: Test", "Context", "Steps", "Verification"]);
			expect(result.content).toContain("Step one");
		});

		it("ignores heading-like lines inside code fences", () => {
			const path = join(TEST_PLANS_DIR, "fences.md");
			writeFileSync(
				path,
				"# Plan\n\n## Steps\n```bash\n# not a heading\necho hi\n```\n\n## Verification\nRun tests\n",
				"utf-8",
			);
			const result = readPlanFile(path);
			expect(result.headings).toEqual(["Plan", "Steps", "Verification"]);
		});

		it("reports read errors instead of pretending the plan does not exist", () => {
			// A directory exists but can't be read as a file → error, not exists=false-silence
			const result = readPlanFile(TEST_PLANS_DIR);
			expect(result.exists).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe("active plan resolution", () => {
		it("prefers the plan most recently written via plan_write", () => {
			const state = testState("active-1");
			execPlanWrite({ name: "first", content: "# First" }, state);
			execPlanWrite({ name: "second", content: "# Second" }, state);
			execPlanWrite({ name: "first", content: "# First again" }, state);

			expect(resolveActivePlanPath(state)).toBe(join(state.plansDir, "first.md"));
			expect(readActivePlan(state).content).toBe("# First again");
		});

		it("falls back to the newest file on disk when the in-memory marker is gone (resume)", () => {
			const state = testState("active-2");
			execPlanWrite({ name: "old", content: "# Old" }, state);
			execPlanWrite({ name: "new", content: "# New" }, state);
			// Distinct mtimes — same-ms writes would make the order ambiguous.
			const past = new Date(Date.now() - 60_000);
			utimesSync(join(state.plansDir, "old.md"), past, past);

			const resumed = testState("active-2"); // fresh state, no activePlanPath
			expect(resolveActivePlanPath(resumed)).toBe(join(resumed.plansDir, "new.md"));
		});

		it("resolves to undefined when the session has no plans", () => {
			const state = testState("active-3");
			expect(resolveActivePlanPath(state)).toBeUndefined();
			expect(readActivePlan(state).exists).toBe(false);
		});
	});

	describe("execPlanWrite", () => {
		it("writes a named plan and makes it active", () => {
			const state = testState("write-1");

			const result = execPlanWrite({ name: "Auth Refactor", content: "# Plan\n\n## Steps\n1. Do thing" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);
			expect(parsed.name).toBe("auth-refactor");
			expect(parsed.charCount).toBeGreaterThan(0);

			expect(state.activePlanPath).toBe(join(state.plansDir, "auth-refactor.md"));
			const file = readPlanFile(state.activePlanPath!);
			expect(file.exists).toBe(true);
			expect(file.headings).toEqual(["Plan", "Steps"]);
		});

		it("rejects a missing or unusable name", () => {
			const state = testState("write-2");
			expect(execPlanWrite({ content: "# Plan" }, state).isError).toBe(true);
			expect(execPlanWrite({ name: "..", content: "# Plan" }, state).isError).toBe(true);
		});

		it("rejects empty content", () => {
			const state = testState("write-3");
			const result = execPlanWrite({ name: "x", content: "" }, state);
			expect(result.isError).toBe(true);
		});

		it("overwrites a plan written under the same name", () => {
			const state = testState("write-4");

			execPlanWrite({ name: "main", content: "# First plan\n\n## Steps\nOld steps" }, state);
			execPlanWrite({ name: "main", content: "# Second plan\n\n## Steps\nNew steps" }, state);

			const file = readActivePlan(state);
			expect(file.content).toContain("Second plan");
			expect(file.content).not.toContain("First plan");
			expect(listPlanNames(state.plansDir)).toEqual(["main"]);
		});

		it("keeps several named plans side by side", () => {
			const state = testState("write-5");

			execPlanWrite({ name: "backend", content: "# Backend" }, state);
			execPlanWrite({ name: "frontend", content: "# Frontend" }, state);

			expect(listPlanNames(state.plansDir)).toEqual(["backend", "frontend"]);
		});
	});

	describe("execPlanEdit", () => {
		it("edits a section of the active plan by heading match", () => {
			const state = testState("edit-1");

			execPlanWrite(
				{
					name: "main",
					content:
						"# Plan\n\n## Context\nOld context\n\n## Steps\n1. Step one\n\n## Verification\nOld verification",
				},
				state,
			);

			const result = execPlanEdit({ heading: "Steps", content: "1. New step A\n2. New step B" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);
			expect(parsed.section).toBe("Steps");
			expect(parsed.plan).toBe("main");

			const file = readActivePlan(state);
			expect(file.content).toContain("New step A");
			expect(file.content).toContain("New step B");
			expect(file.content).toContain("## Context\nOld context");
			expect(file.content).toContain("## Verification\nOld verification");
		});

		it("matches heading case-insensitively", () => {
			const state = testState("edit-2");

			execPlanWrite({ name: "main", content: "# Plan\n\n## Verification\nOld" }, state);

			const result = execPlanEdit({ heading: "verification", content: "New verification" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);
		});

		it("returns error when heading not found", () => {
			const state = testState("edit-3");

			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n1. Step" }, state);

			const result = execPlanEdit({ heading: "Nonexistent", content: "New" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.currentHeadings).toEqual(["Plan", "Steps"]);
		});

		it("returns error when no plan exists", () => {
			const state = testState("edit-4");

			const result = execPlanEdit({ heading: "Steps", content: "New" }, state);
			expect(result.isError).toBe(true);
		});

		it("prefers exact heading match over substring", () => {
			const state = testState("edit-5");

			execPlanWrite({ name: "main", content: "# Plan\n\n## Next Steps\nLater\n\n## Steps\n1. Now" }, state);

			const result = execPlanEdit({ heading: "Steps", content: "1. Edited" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);
			expect(parsed.section).toBe("Steps");

			const file = readActivePlan(state);
			expect(file.content).toContain("## Next Steps\nLater");
			expect(file.content).toContain("## Steps\n1. Edited");
		});

		it("returns error when substring matches multiple sections", () => {
			const state = testState("edit-6");

			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps: backend\nA\n\n## Steps: frontend\nB" }, state);

			const result = execPlanEdit({ heading: "Steps", content: "New" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.matchingHeadings).toEqual(["Steps: backend", "Steps: frontend"]);
		});

		it("does not treat fenced code comments as section boundaries", () => {
			const state = testState("edit-7");

			execPlanWrite(
				{
					name: "main",
					content: "# Plan\n\n## Steps\n```bash\n# comment in code\necho hi\n```\nTail\n\n## Verification\nRun",
				},
				state,
			);

			const result = execPlanEdit({ heading: "Verification", content: "New checks" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);

			const file = readActivePlan(state);
			expect(file.content).toContain("# comment in code");
			expect(file.content).toContain("## Verification\nNew checks");
		});
	});

	describe("execPlanRead", () => {
		it("returns exists=false and an empty plan list when no plan", () => {
			const state = testState("read-1");

			const result = execPlanRead({}, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.exists).toBe(false);
			expect(parsed.plans).toEqual([]);
		});

		it("returns the active plan plus the names of all session plans", () => {
			const state = testState("read-2");

			execPlanWrite({ name: "alt", content: "# Alt" }, state);
			execPlanWrite({ name: "main", content: "# Plan\n\n## Context\nInfo" }, state);

			const result = execPlanRead({}, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.exists).toBe(true);
			expect(parsed.name).toBe("main");
			expect(parsed.headings).toEqual(["Plan", "Context"]);
			expect(parsed.content).toContain("Info");
			expect(parsed.plans).toEqual(["alt", "main"]);
		});

		it("in plan mode, reads a named plan and makes it active for subsequent edits", () => {
			const state = testState("read-3");
			state.enabled = true;

			execPlanWrite({ name: "backend", content: "# Backend\n\n## Steps\n- [ ] api" }, state);
			execPlanWrite({ name: "frontend", content: "# Frontend\n\n## Steps\n- [ ] ui" }, state);

			// frontend is active; switch to backend by reading it
			const read = JSON.parse(execPlanRead({ name: "backend" }, state).content);
			expect(read.name).toBe("backend");
			expect(read.content).toContain("api");

			// plan_edit now targets backend, not frontend
			const edit = JSON.parse(execPlanEdit({ heading: "Steps", content: "- [ ] api v2" }, state).content);
			expect(edit.plan).toBe("backend");
			expect(readPlanFile(join(state.plansDir, "frontend.md")).content).toContain("- [ ] ui");
		});

		it("in build mode, reading a named plan is reference-only and does not switch the active plan", () => {
			const state = testState("read-3b"); // enabled stays false — build mode

			execPlanWrite({ name: "backend", content: "# Backend" }, state);
			execPlanWrite({ name: "frontend", content: "# Frontend" }, state);

			const read = JSON.parse(execPlanRead({ name: "backend" }, state).content);
			expect(read.name).toBe("backend");
			// frontend (last written) keeps steering the implementation
			expect(state.activePlanPath).toBe(join(state.plansDir, "frontend.md"));
			expect(readActivePlan(state).content).toBe("# Frontend");
		});

		it("returns error with the plan list when the named plan does not exist", () => {
			const state = testState("read-4");
			execPlanWrite({ name: "main", content: "# Plan" }, state);

			const result = execPlanRead({ name: "nonexistent" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.plans).toEqual(["main"]);
		});
	});

	describe("execPlanCheck", () => {
		const CHECKLIST_PLAN =
			"# Plan\n\n## Steps\n- [ ] add plan_check tool\n- [ ] wire disabledTools\n- [x] already done\n\n## Verification\nnpm test";

		it("marks a checklist item done and reports the remaining count", () => {
			const state = testState("check-1");
			execPlanWrite({ name: "main", content: CHECKLIST_PLAN }, state);

			const result = execPlanCheck({ item: "wire disabledTools" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("wire disabledTools");
			expect(parsed.remaining).toBe(1);

			const file = readActivePlan(state);
			expect(file.content).toContain("- [x] wire disabledTools");
			expect(file.content).toContain("- [ ] add plan_check tool");
		});

		it("reports allDone when the last item is checked", () => {
			const state = testState("check-2");
			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n- [ ] only step" }, state);

			const parsed = JSON.parse(execPlanCheck({ item: "only step" }, state).content);
			expect(parsed.remaining).toBe(0);
			expect(parsed.allDone).toBe(true);
		});

		it("matches case-insensitively and prefers exact over substring", () => {
			const state = testState("check-3");
			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n- [ ] add tool\n- [ ] add tool docs" }, state);

			const parsed = JSON.parse(execPlanCheck({ item: "Add Tool" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("add tool");

			const file = readActivePlan(state);
			expect(file.content).toContain("- [x] add tool\n");
			expect(file.content).toContain("- [ ] add tool docs");
		});

		it("returns error with candidates when the item is ambiguous", () => {
			const state = testState("check-4");
			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n- [ ] fix loop.ts\n- [ ] fix tools.ts" }, state);

			const result = execPlanCheck({ item: "fix" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.matchingItems).toEqual(["fix loop.ts", "fix tools.ts"]);
		});

		it("returns error with the remaining items when nothing matches", () => {
			const state = testState("check-5");
			execPlanWrite({ name: "main", content: CHECKLIST_PLAN }, state);

			const result = execPlanCheck({ item: "nonexistent step" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			// Already-checked items are not offered as candidates.
			expect(parsed.uncheckedItems).toEqual(["add plan_check tool", "wire disabledTools"]);
		});

		it("returns error when the plan has no unchecked items or no plan exists", () => {
			const state = testState("check-6");
			expect(execPlanCheck({ item: "x" }, state).isError).toBe(true);

			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n- [x] all done" }, state);
			expect(execPlanCheck({ item: "all done" }, state).isError).toBe(true);
		});

		it("never matches checkbox-like lines inside code fences", () => {
			const state = testState("check-fence");
			execPlanWrite(
				{
					name: "main",
					content: "# Plan\n\n## Steps\n- [ ] update template\n```markdown\n- [ ] update sample\n```",
				},
				state,
			);

			// Substring common to both — only the real step is a candidate, so no
			// ambiguity error and the fenced example stays untouched.
			const parsed = JSON.parse(execPlanCheck({ item: "update" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("update template");

			const file = readActivePlan(state);
			expect(file.content).toContain("- [x] update template");
			expect(file.content).toContain("- [ ] update sample");
		});

		it("checks an item off in a named plan without touching the active one", () => {
			const state = testState("check-7");
			execPlanWrite({ name: "backend", content: "# Backend\n\n## Steps\n- [ ] api" }, state);
			execPlanWrite({ name: "frontend", content: "# Frontend\n\n## Steps\n- [ ] ui" }, state);

			const parsed = JSON.parse(execPlanCheck({ item: "api", plan: "backend" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.plan).toBe("backend");

			expect(readPlanFile(join(state.plansDir, "backend.md")).content).toContain("- [x] api");
			expect(readPlanFile(join(state.plansDir, "frontend.md")).content).toContain("- [ ] ui");
			// active plan (frontend) unchanged by targeting another plan
			expect(state.activePlanPath).toBe(join(state.plansDir, "frontend.md"));
		});

		it("returns error with the plan list for an unknown plan name", () => {
			const state = testState("check-8");
			execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n- [ ] x" }, state);

			const result = execPlanCheck({ item: "x", plan: "ghost" }, state);
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content).plans).toEqual(["main"]);
		});
	});

	describe("execPlanDiscard", () => {
		it("deletes a named plan; active falls back to the newest remaining", () => {
			const state = testState("discard-1");
			execPlanWrite({ name: "keep", content: "# Keep" }, state);
			execPlanWrite({ name: "drop", content: "# Drop" }, state);
			expect(state.activePlanPath).toBe(join(state.plansDir, "drop.md"));

			const parsed = JSON.parse(execPlanDiscard({ name: "drop" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.discarded).toBe("drop");
			expect(parsed.plans).toEqual(["keep"]);
			expect(parsed.active).toBe("keep");
			expect(existsSync(join(state.plansDir, "drop.md"))).toBe(false);
			expect(readActivePlan(state).content).toBe("# Keep");
		});

		it("errors with the plan list for an unknown name", () => {
			const state = testState("discard-2");
			execPlanWrite({ name: "main", content: "# Plan" }, state);

			const result = execPlanDiscard({ name: "ghost" }, state);
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content).plans).toEqual(["main"]);
		});

		it("requires a name and neutralizes traversal", () => {
			const state = testState("discard-3");
			expect(execPlanDiscard({}, state).isError).toBe(true);
			// "../x" slugs to "x" — outside files are unreachable by construction.
			expect(execPlanDiscard({ name: "../../etc/passwd" }, state).isError).toBe(true);
		});
	});

	describe("execPlanEnter", () => {
		it("returns the plan-suggested signal with the reason", () => {
			const state = testState("enter-1");
			const parsed = JSON.parse(execPlanEnter({ reason: "touches auth across 6 files" }, state).content);
			expect(parsed.planSuggested).toBe(true);
			expect(parsed.reason).toBe("touches auth across 6 files");
		});

		it("requires a reason", () => {
			const state = testState("enter-2");
			expect(execPlanEnter({}, state).isError).toBe(true);
			expect(execPlanEnter({ reason: "  " }, state).isError).toBe(true);
		});
	});

	describe("execPlanDone", () => {
		it("returns error when no plan exists", () => {
			const state = testState("done-1");

			const result = execPlanDone({}, state);
			expect(result.isError).toBe(true);
		});

		it("returns plan ready signal with the active plan's name and content", () => {
			const state = testState("done-2");

			execPlanWrite({ name: "auth", content: "# Plan\n\n## Steps\n1. Do it" }, state);

			const result = execPlanDone({ summary: "Auth refactor" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.planReady).toBe(true);
			expect(parsed.name).toBe("auth");
			expect(parsed.summary).toBe("Auth refactor");
			expect(parsed.content).toContain("Do it");
		});
	});
});
