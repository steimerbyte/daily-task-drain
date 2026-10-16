import {
	isInSourceFolder,
	isPathExcluded,
	isSameFile,
	normalizeVaultPath,
	parseFolderList,
} from "../src/exclusions";

describe("parseFolderList", () => {
	it("splits on newlines and drops empty entries", () => {
		expect(parseFolderList("Journal/\n\nTemplates/  \nAGENT/\n")).toEqual(["Journal/", "Templates/", "AGENT/"]);
	});

	it("handles CRLF input", () => {
		expect(parseFolderList("Journal/\r\nTemplates/")).toEqual(["Journal/", "Templates/"]);
	});

	it("returns an empty list for an empty setting", () => {
		expect(parseFolderList("   \n\n")).toEqual([]);
	});
});

describe("normalizeVaultPath", () => {
	it("turns backslashes into slashes", () => {
		expect(normalizeVaultPath("Journal\\Templates")).toBe("journal/templates");
	});

	it("strips surrounding whitespace and slashes", () => {
		expect(normalizeVaultPath("  /Journal/Templates/  ")).toBe("journal/templates");
	});

	it("lower-cases for case-insensitive comparison", () => {
		expect(normalizeVaultPath("JOURNAL/2026")).toBe("journal/2026");
	});
});

describe("isPathExcluded", () => {
	const excluded = ["Journal/", "Templates/", "099_Archiv/", "AGENT/"];

	it("excludes a file directly inside an excluded folder", () => {
		expect(isPathExcluded("Journal/2026/2026-10-16.md", excluded)).toBe(true);
	});

	it("excludes files in subfolders of an excluded folder", () => {
		expect(isPathExcluded("099_Archiv/2025/old.md", excluded)).toBe(true);
	});

	it("does not exclude a file whose name merely starts with the folder name", () => {
		expect(isPathExcluded("Journale/notebook.md", excluded)).toBe(false);
	});

	it("does not exclude a folder that only appears inside the path", () => {
		expect(isPathExcluded("Projekte/Journal/notes.md", excluded)).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isPathExcluded("journal/2026/2026-10-16.md", excluded)).toBe(true);
	});

	it("matches the entry itself, so a single file can be excluded", () => {
		expect(isPathExcluded("Projekte/archiv.md", ["Projekte/archiv.md"])).toBe(true);
		expect(isPathExcluded("Projekte/archiv.md.bak", ["Projekte/archiv.md"])).toBe(false);
	});

	it("does not exclude anything when the list is empty", () => {
		expect(isPathExcluded("Notes/todo.md", [])).toBe(false);
	});

	it("ignores empty entries", () => {
		expect(isPathExcluded("Notes/todo.md", ["", "  "])).toBe(false);
	});

	it("does not exclude an empty path", () => {
		expect(isPathExcluded("", excluded)).toBe(false);
	});
});

describe("isInSourceFolder", () => {
	it("accepts everything when no source folder is configured", () => {
		expect(isInSourceFolder("Notes/todo.md", "")).toBe(true);
	});

	it("accepts files in the source folder and its subfolders", () => {
		expect(isInSourceFolder("Projects/a.md", "Projects")).toBe(true);
		expect(isInSourceFolder("Projects/2026/a.md", "Projects")).toBe(true);
	});

	it("rejects files outside the source folder", () => {
		expect(isInSourceFolder("Private/a.md", "Projects")).toBe(false);
	});

	it("does not match a sibling folder with a shared prefix", () => {
		expect(isInSourceFolder("ProjectsArchive/a.md", "Projects")).toBe(false);
	});
});

describe("isSameFile", () => {
	it("compares normalised paths", () => {
		expect(isSameFile("Journal/2026-10-16.md", "/journal/2026-10-16.md")).toBe(true);
		expect(isSameFile("Journal/2026-10-16.md", "Journal/2026-10-17.md")).toBe(false);
	});
});