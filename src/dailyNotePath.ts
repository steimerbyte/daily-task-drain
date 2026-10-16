/**
 * Pure path arithmetic for daily notes, kept free of Obsidian imports so the
 * folder-creation behaviour can be regression-tested in plain Node.
 *
 * The bug this module exists to prevent: the daily-notes settings carry a
 * vault-level `folder` ("Journal") while the `format` may add sub-folders
 * ("YYYY/MM/YYYY-MM-DD"). Creating only `folder` leaves "Journal/2026/10"
 * missing in a vault that has never seen October, and both `createDailyNote()`
 * and `vault.create()` then fail because the parent directory is absent.
 */

/**
 * Directory part of a vault path, or an empty string for a file in the vault
 * root. `"Journal/2026/10/2026-10-16.md"` becomes `"Journal/2026/10"`.
 */
export function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/**
 * The folders that still have to be created before `path` can be written,
 * outermost first.
 *
 * `"Journal/2026/10/2026-10-16.md"` yields `["Journal", "Journal/2026",
 * "Journal/2026/10"]`, minus everything `exists` already reports as present.
 * A file in the vault root yields an empty list. The `exists` callback is
 * injected so the caller can use the vault's own lookup while the logic stays
 * testable without Obsidian.
 */
export function missingFolders(path: string, exists: (folder: string) => boolean): string[] {
	const segments = parentOf(path).split("/").filter((segment) => segment.length > 0);
	const chain: string[] = [];
	let current = "";

	for (const segment of segments) {
		current = current.length === 0 ? segment : `${current}/${segment}`;
		if (!exists(current)) chain.push(current);
	}

	return chain;
}