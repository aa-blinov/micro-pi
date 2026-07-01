/**
 * Deterministic on-disk fixtures for eval cases that need grounded verification
 * (multi-file edits, execution-based checks) instead of trusting the model's
 * self-reported response text.
 *
 * Fixtures live under a per-process root (`/tmp/cast-eval/<uuid>`), generated
 * once when this module loads. That uuid is what lets two concurrent
 * `evals/run.ts` invocations target the same case id without racing on the same
 * directory — each process gets its own root. Call `cleanupFixtures()` once the
 * suite finishes to remove it; nothing here cleans up on its own.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_ROOT = join("/tmp/cast-eval", randomUUID());

/**
 * Recreate a fixture directory for the given case id with the given file
 * contents (relative path -> content).
 */
export function writeFixture(id: string, files: Record<string, string>): string {
	const dir = fixtureDir(id);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [relPath, content] of Object.entries(files)) {
		writeFileSync(join(dir, relPath), content, "utf-8");
	}
	return dir;
}

export function fixtureDir(id: string): string {
	return join(FIXTURES_ROOT, id);
}

export function fixturePath(id: string, relPath: string): string {
	return join(fixtureDir(id), relPath);
}

/** Remove this process's entire fixture root. Call once after the suite finishes. */
export function cleanupFixtures(): void {
	rmSync(FIXTURES_ROOT, { recursive: true, force: true });
}
