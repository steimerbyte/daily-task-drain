/**
 * Path exclusion for Daily Task Drain.
 *
 * Like the parser this module imports nothing from Obsidian so the matching
 * rules stay unit-testable.
 */

/** Splits the textarea value of the setting into individual folder entries. */
export function parseFolderList(raw: string): string[] {
	return raw
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Cleans a vault path so it can address a real file: backslashes become
 * slashes, surrounding whitespace and leading/trailing slashes are dropped.
 * The case is preserved, because a vault on Linux is case-sensitive:
 * `Journal` and `journal` are two different folders there.
 */
export function cleanVaultPath(path: string): string {
	return path
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

/**
 * Normalises a vault path for comparison: as {@link cleanVaultPath}, plus
 * lower-casing, because exclusion and folder matching should not depend on
 * the case a user typed.
 *
 * Never use this to look a file up; lower-casing the path breaks the lookup on
 * a case-sensitive filesystem.
 */
export function normalizeVaultPath(path: string): string {
	return cleanVaultPath(path).toLowerCase();
}

/**
 * True when `filePath` is covered by one of the excluded entries.
 *
 * An entry matches when it equals the file (a file exclusion) or when the file
 * lives underneath it, subfolders included.
 */
export function isPathExcluded(filePath: string, excludedPaths: string[]): boolean {
	const file = normalizeVaultPath(filePath);
	if (file.length === 0) return false;

	return excludedPaths.some((entry) => {
		const excluded = normalizeVaultPath(entry);
		if (excluded.length === 0) return false;
		return file === excluded || file.startsWith(`${excluded}/`);
	});
}

/**
 * True when the file lies inside `sourceFolder`. An empty folder means the
 * whole vault and therefore matches everything.
 */
export function isInSourceFolder(filePath: string, sourceFolder: string): boolean {
	const folder = normalizeVaultPath(sourceFolder);
	if (folder.length === 0) return true;

	const file = normalizeVaultPath(filePath);
	return file === folder || file.startsWith(`${folder}/`);
}

/** The daily note itself must never drain into itself. */
export function isSameFile(filePath: string, otherPath: string): boolean {
	return normalizeVaultPath(filePath) === normalizeVaultPath(otherPath);
}