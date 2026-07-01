import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export interface ClipboardImage {
	bytes: Buffer;
	mimeType: string;
}

export type ClipboardImageResult =
	| { ok: true; image: ClipboardImage }
	| { ok: false; error: string }
	| { ok: false; error: null };

function isCommandNotFound(error: unknown): boolean {
	return error instanceof Error && ("code" in error ? (error as NodeJS.ErrnoException).code === "ENOENT" : false);
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
	const platform = process.platform;
	try {
		if (platform === "darwin") {
			const { stdout } = await execAsync("pngpaste -", {
				encoding: "buffer",
				maxBuffer: MAX_IMAGE_BYTES,
			});
			if (!stdout || stdout.length === 0) return { ok: false, error: null };
			return { ok: true, image: { bytes: stdout as Buffer, mimeType: "image/png" } };
		}
		if (platform === "linux") {
			const { stdout } = await execAsync("xclip -selection clipboard -t image/png -o", {
				encoding: "buffer",
				maxBuffer: MAX_IMAGE_BYTES,
			});
			if (!stdout || stdout.length === 0) return { ok: false, error: null };
			return { ok: true, image: { bytes: stdout as Buffer, mimeType: "image/png" } };
		}
		if (platform === "win32") {
			const ps =
				"Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
				"$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
				"if ($img) { " +
				"$ms = New-Object System.IO.MemoryStream; " +
				"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); " +
				"[Convert]::ToBase64String($ms.ToArray()) " +
				"}";
			const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, {
				encoding: "utf-8",
				maxBuffer: MAX_IMAGE_BYTES,
			});
			const b64 = stdout.trim();
			if (!b64) return { ok: false, error: null };
			return { ok: true, image: { bytes: Buffer.from(b64, "base64"), mimeType: "image/png" } };
		}
		return { ok: false, error: `Clipboard image paste isn't supported on ${platform}.` };
	} catch (error) {
		if (platform === "darwin" && isCommandNotFound(error)) {
			return { ok: false, error: "pngpaste not found — install: brew install pngpaste" };
		}
		if (platform === "linux" && isCommandNotFound(error)) {
			return { ok: false, error: "xclip not found — install: apt install xclip" };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Couldn't read clipboard: ${message.slice(0, 200)}` };
	}
}

export async function saveClipboardImageToTempFile(): Promise<string | null> {
	const result = await readClipboardImage();
	if (!result.ok || !result.image) return null;

	const ext = result.image.mimeType === "image/jpeg" ? "jpg" : "png";
	const filePath = join(tmpdir(), `cast-clipboard-${randomUUID()}.${ext}`);
	writeFileSync(filePath, result.image.bytes);
	return filePath;
}
