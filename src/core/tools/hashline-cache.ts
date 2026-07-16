/**
 * In-memory LRU cache of `computeLineHashes` results, keyed by absolute
 * path. The mtime at read time is stored alongside the hashes; on the
 * next `get` we re-stat the file and discard the cached entry if it
 * changed. This is a hot path for `read`/`edit`/`grep` — a model that
 * re-reads a file between two `edit` calls now skips both the file I/O
 * and the per-line sha1, and a model that runs the same `grep` twice
 * in a row skips the per-line hashing for every file it already saw.
 *
 * Capacity is bounded — 20 entries by default, ~4 MB worst case — and
 * `invalidate` is called by the write/edit tools so we never serve a
 * stale snapshot after we've mutated the file ourselves.
 *
 * Pure single-process: the cache lives in this module's closure, no
 * cross-IPC, no disk persistence. The agent is the only writer.
 */

import { stat } from "node:fs/promises";
import { computeLineHashes } from "./hashline.ts";

const DEFAULT_CAPACITY = 20;

export interface CachedFile {
	raw: string;
	lines: string[];
	hashes: Array<[string, string]>;
	mtimeMs: number;
}

interface Entry {
	key: string;
	value: CachedFile;
	prev: Entry | null;
	next: Entry | null;
}

/** Doubly-linked LRU. `head` is most-recently-used, `tail` is eviction target. */
class Lru {
	private readonly cap: number;
	private readonly map = new Map<string, Entry>();
	private head: Entry | null = null;
	private tail: Entry | null = null;

	constructor(capacity: number = DEFAULT_CAPACITY) {
		this.cap = capacity;
	}

	get(key: string): CachedFile | null {
		const e = this.map.get(key);
		if (!e) return null;
		this.touch(e);
		return e.value;
	}

	get size(): number {
		return this.map.size;
	}

	put(key: string, value: CachedFile): void {
		const existing = this.map.get(key);
		if (existing) {
			existing.value = value;
			this.touch(existing);
			return;
		}
		const e: Entry = { key, value, prev: null, next: this.head };
		if (this.head) this.head.prev = e;
		this.head = e;
		if (!this.tail) this.tail = e;
		this.map.set(key, e);
		if (this.map.size > this.cap) {
			const victim = this.tail;
			if (victim) {
				this.unlink(victim);
				this.map.delete(victim.key);
			}
		}
	}

	delete(key: string): void {
		const e = this.map.get(key);
		if (!e) return;
		this.unlink(e);
		this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
		this.head = null;
		this.tail = null;
	}

	private touch(e: Entry): void {
		if (this.head === e) return;
		this.unlink(e);
		e.prev = null;
		e.next = this.head;
		if (this.head) this.head.prev = e;
		this.head = e;
		if (!this.tail) this.tail = e;
	}

	private unlink(e: Entry): void {
		if (e.prev) e.prev.next = e.next;
		else this.head = e.next;
		if (e.next) e.next.prev = e.prev;
		else this.tail = e.prev;
		e.prev = null;
		e.next = null;
	}
}

const cache = new Lru();

/**
 * Load `path` and return its raw content, line-split, and per-line
 * hashes — served from the LRU when possible. On miss the file is
 * read once, hashed in a single pass, and the result cached.
 *
 * If the file's mtime has changed since it was cached, the entry is
 * dropped and a fresh one is computed. We only stat on hit, not on
 * miss — the cost is negligible either way (a `stat` is cheaper than
 * an open+read+close), and skipping it on miss lets the first read
 * after startup stay a single syscall.
 */
export async function getCachedFile(path: string): Promise<CachedFile> {
	const hit = cache.get(path);
	if (hit) {
		try {
			const st = await stat(path);
			if (st.mtimeMs === hit.mtimeMs) {
				return hit;
			}
		} catch {
			// stat failed (file gone, permission revoked) — treat as miss
			// and let the readFile below produce a real error.
		}
		cache.delete(path);
	}

	// Lazy import: the cache module pulls in node:fs/promises only here,
	// so unit tests that import `hashline.ts` stay fs-free.
	const { readFile } = await import("node:fs/promises");
	const raw = await readFile(path, "utf-8");
	const st = await stat(path);
	const lines = raw.split("\n");
	const hashes = computeLineHashes(raw);
	const value: CachedFile = { raw, lines, hashes, mtimeMs: st.mtimeMs };
	cache.put(path, value);
	return value;
}

/** Called by the write/edit tools after mutating a file. */
export function invalidateCachedFile(path: string): void {
	cache.delete(path);
}

/** Test-only: drop everything. */
export function clearHashlineCache(): void {
	cache.clear();
}

/** Test-only: how many entries the LRU currently holds. */
export function hashlineCacheSize(): number {
	return cache.size;
}
