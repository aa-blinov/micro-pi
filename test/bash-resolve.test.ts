import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunCommand, resolveBashFrom } from "../src/core/tools/bash.ts";

// The win32 branch can't be exercised end-to-end from CI on mac/linux, so the
// resolution order is pinned here against the injectable pure function:
// CAST_BASH → GitForWindows registry (HKCU, then HKLM) → known install paths
// → derivation from `git` on PATH → PATH bash (+ WSL warning on win32).

const PF = "C:\\Program Files";
const PF86 = "C:\\Program Files (x86)";
const LOCAL = "C:\\Users\\u\\AppData\\Local";
const HOME = "C:\\Users\\u";
const winEnv = { ProgramFiles: PF, "ProgramFiles(x86)": PF86, LOCALAPPDATA: LOCAL, USERPROFILE: HOME };

const existsAt = (...paths: string[]) => {
	const set = new Set(paths);
	return (p: string) => set.has(p);
};
const noRun: RunCommand = () => null;

/** Fake `reg.exe query` for a hive → InstallPath mapping; `where.exe git.exe` optional. */
function fakeRun(opts: { hkcu?: string; hklm?: string; whereGit?: string[] }): RunCommand {
	return (file, args) => {
		if (file === "reg.exe") {
			const hive = args[1]?.startsWith("HKCU") ? opts.hkcu : args[1]?.startsWith("HKLM") ? opts.hklm : undefined;
			if (!hive) return null;
			return `HKEY\\Software\\GitForWindows\n    InstallPath    REG_SZ    ${hive}\n`;
		}
		if (file === "where.exe") return opts.whereGit?.join("\r\n") ?? null;
		return null;
	};
}

describe("resolveBashFrom", () => {
	it("returns plain bash on non-windows platforms without probing the FS", () => {
		let probed = false;
		const r = resolveBashFrom("darwin", {}, () => {
			probed = true;
			return true;
		});
		expect(r).toEqual({ path: "bash" });
		expect(probed).toBe(false);
	});

	it("CAST_BASH override wins over everything and is used verbatim", () => {
		const r = resolveBashFrom(
			"win32",
			{ ...winEnv, CAST_BASH: "D:\\msys64\\usr\\bin\\bash.exe" },
			() => true,
			fakeRun({ hklm: "C:\\Git" }),
		);
		expect(r).toEqual({ path: "D:\\msys64\\usr\\bin\\bash.exe" });
	});

	it("resolves through the GitForWindows registry key first (any install drive)", () => {
		const bash = join("D:\\tools\\Git", "bin", "bash.exe");
		const r = resolveBashFrom("win32", winEnv, existsAt(bash), fakeRun({ hklm: "D:\\tools\\Git" }));
		expect(r).toEqual({ path: bash });
	});

	it("prefers the per-user HKCU install over the machine-wide HKLM one", () => {
		const userBash = join("C:\\UserGit", "bin", "bash.exe");
		const machineBash = join("C:\\MachineGit", "bin", "bash.exe");
		const r = resolveBashFrom(
			"win32",
			winEnv,
			existsAt(userBash, machineBash),
			fakeRun({ hkcu: "C:\\UserGit", hklm: "C:\\MachineGit" }),
		);
		expect(r).toEqual({ path: userBash });
	});

	it("falls back to usr\\bin\\bash.exe when bin\\bash.exe is absent in the registry install", () => {
		const usrBash = join("C:\\Git", "usr", "bin", "bash.exe");
		const r = resolveBashFrom("win32", winEnv, existsAt(usrBash), fakeRun({ hklm: "C:\\Git" }));
		expect(r).toEqual({ path: usrBash });
	});

	it("checks the known install paths when the registry has nothing", () => {
		for (const bash of [
			join(PF, "Git", "bin", "bash.exe"),
			join(PF86, "Git", "bin", "bash.exe"),
			join(LOCAL, "Programs", "Git", "bin", "bash.exe"), // no-admin per-user default
			join(HOME, "scoop", "apps", "git", "current", "bin", "bash.exe"),
		]) {
			expect(resolveBashFrom("win32", winEnv, existsAt(bash), noRun)).toEqual({ path: bash });
		}
	});

	it("derives bash from `git` on PATH as a last discovery step", () => {
		const gitExe = "E:\\portable\\Git\\cmd\\git.exe";
		const bash = join("E:\\portable\\Git\\cmd", "..", "..", "bin", "bash.exe");
		const r = resolveBashFrom("win32", winEnv, existsAt(bash), fakeRun({ whereGit: [gitExe] }));
		expect(r).toEqual({ path: bash });
	});

	it("skips shim launchers that don't sit inside a Git root", () => {
		// scoop shims live in ~\scoop\shims\git.exe — no bash.exe two levels up.
		const r = resolveBashFrom(
			"win32",
			winEnv,
			() => false,
			fakeRun({ whereGit: ["C:\\Users\\u\\scoop\\shims\\git.exe"] }),
		);
		expect(r.path).toBe("bash");
	});

	it("falls back to PATH bash on win32 with a warning about the WSL shim", () => {
		const r = resolveBashFrom("win32", winEnv, () => false, noRun);
		expect(r.path).toBe("bash");
		expect(r.warning).toContain("WSL");
		expect(r.warning).toContain("CAST_BASH");
	});

	it("uses default install roots when the env vars are absent", () => {
		const gitBash = join("C:\\Program Files", "Git", "bin", "bash.exe");
		expect(resolveBashFrom("win32", {}, existsAt(gitBash), noRun)).toEqual({ path: gitBash });
	});
});
