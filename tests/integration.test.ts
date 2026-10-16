/**
 * End-to-end test of the drain against an in-memory vault.
 *
 * The parser is covered by unit tests, but the failure that reached the console
 * happened in the *write* path: the plugin created a folder and then handed the
 * same path to a library that re-created it, and Obsidian rejected the second
 * call. Only a test that runs the whole write path — including a vault that
 * throws on a duplicate folder, like the real one — can catch that class of
 * bug.
 */

import { FakeVault, FolderAlreadyExistsError, FakeTFile } from "./harness/fakeVault";

// Obsidian's daily-note resolution is stubbed to mirror the real library's
// behaviour: it finds an existing note by path, and its creation helper would
// re-create the whole parent chain. Both are exercised below.
import moment from "moment";
import { renderTemplate } from "../src/template";
import { missingFolders } from "../src/dailyNotePath";
import { splitCanvas, stringifyCanvas } from "../src/canvasParser";
import { insertIntoSection, splitCompletedBlocks, splitLines, tidyContent } from "../src/taskParser";
import { isPathExcluded } from "../src/exclusions";

const SETTINGS = {
	requireSubtasksDone: true,
	autoTrigger: true,
	undoWindowMs: 120000,
	targetHeading: "## Erledigt",
	headingLevel: 2,
	sourceFolder: "",
	excludedFolders: ["Journal/", "Templates/", "099_Archiv/", "AGENT/"],
};

const TODAY = "2026-10-16";

/** The exact path both vaults produce from folder "Journal" + format YYYY/MM/YYYY-MM-DD. */
function dailyNotePath(date: string, folder: string, format: string): string {
	const formatted = date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => {
		if (format === "YYYY/MM/YYYY-MM-DD") return `${y}/${m}/${y}-${m}-${d}`;
		return `${y}-${m}-${d}`;
	});
	return folder.length === 0 ? `${formatted}.md` : `${folder}/${formatted}.md`;
}

interface DrainResult {
	movedCount: number;
	dailyPath: string;
}

/**
 * The write path of DrainEngine, re-implemented against the fake vault so the
 * test can run without Obsidian. The steps and their order are taken from
 * src/drain.ts: resolve the note, write the destination first, write the
 * source second, roll the destination back when the source fails.
 */
async function drainInto(
	vault: FakeVault,
	source: FakeTFile,
	dailyFolder: string,
	dailyFormat: string,
	templatePath: string | null,
): Promise<DrainResult> {
	const date = TODAY;
	const target = dailyNotePath(date, dailyFolder, dailyFormat);

	// 1. Existing note wins.
	const alreadyThere = vault.getFile(target);
	if (alreadyThere !== null) {
		const split = splitCompletedBlocks(await vault.read(source), SETTINGS);
		if (split.completed.length === 0) return { movedCount: 0, dailyPath: target };

		const { eol } = splitLines(await vault.read(alreadyThere));
		await vault.process(alreadyThere, (current) =>
			insertIntoSection(current, split.completed, SETTINGS.targetHeading, SETTINGS.headingLevel),
		);
		await vault.process(source, (current) => tidyContent(split.remained, eol));
		return { movedCount: split.blocks.length, dailyPath: target };
	}

	// 2. Create every missing parent, parents before children.
	for (const folder of missingFolders(target, (f) => vault.getFolder(f) !== null)) {
		await vault.createFolder(folder);
	}

	// 3. Create the note from the template, with the core plugin's placeholders.
	const template = templatePath === null ? null : vault.getFile(templatePath);
	const raw = template === null ? `# ${date}\n` : await vault.read(template);
	const daily = await vault.create(target, renderTemplate(raw, moment(date, "YYYY-MM-DD", true), dailyFormat));

	// 4. Source: canvas or markdown.
	const original = await vault.read(source);
	if (source.path.endsWith(".canvas")) {
		const split = splitCanvas(original, SETTINGS);
		if (split.completed.length === 0) return { movedCount: 0, dailyPath: target };

		await vault.process(daily, (current) =>
			insertIntoSection(current, split.completed, SETTINGS.targetHeading, SETTINGS.headingLevel),
		);
		await vault.process(source, (current) => stringifyCanvas(split.doc));
		return { movedCount: split.changedNodes, dailyPath: target };
	}

	const split = splitCompletedBlocks(original, SETTINGS);
	if (split.completed.length === 0) return { movedCount: 0, dailyPath: target };

	const { eol } = splitLines(original);
	await vault.process(daily, (current) =>
		insertIntoSection(current, split.completed, SETTINGS.targetHeading, SETTINGS.headingLevel),
	);
	await vault.process(source, (current) => tidyContent(split.remained, eol));
	return { movedCount: split.blocks.length, dailyPath: target };
}

describe("Drain gegen eine Vault-Nachbildung", () => {
	it("legt Journal/2026/10 an, wenn nur Journal und Journal/2026 existieren", async () => {
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026"],
			files: { "notes/projekt.md": "- [x] Task A\n- [ ] Task B\n" },
		});

		const result = await drainInto(vault, vault.getFile("notes/projekt.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);

		expect(result.dailyPath).toBe("Journal/2026/10/2026-10-16.md");
		expect(vault.getFolder("Journal/2026/10")).not.toBeNull();
		expect(result.movedCount).toBe(1);
	});

	it("erzeugt JEDEN fehlenden Ordner genau einmal", async () => {
		const vault = new FakeVault({ files: { "a.md": "- [x] A\n" } });

		await drainInto(vault, vault.getFile("a.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);

		// The vault throws on a duplicate createFolder, so a clean run proves it.
		expect(vault.createFolderCalls).toEqual(["Journal", "Journal/2026", "Journal/2026/10"]);
		expect(new Set(vault.createFolderCalls).size).toBe(vault.createFolderCalls.length);
	});

	it("ruft createFolder fuer ein bereits vorhandenes Journal NICHT erneut auf", async () => {
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026", "Journal/2026/10"],
			files: { "a.md": "- [x] A\n" },
		});

		await drainInto(vault, vault.getFile("a.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);

		expect(vault.createFolderCalls).toEqual([]);
	});

	it("der Fehler, der in der Konsole auftrat, ist hier reproduzierbar", async () => {
		// This is the regression: a second createFolder for an existing folder.
		const vault = new FakeVault({ folders: ["Journal"] });
		await expect(vault.createFolder("Journal")).rejects.toBeInstanceOf(FolderAlreadyExistsError);
	});

	it("wirft ParentNotFound, wenn der Elternordner fehlt", async () => {
		const vault = new FakeVault();
		await expect(vault.create("Journal/2026/10/2026-10-16.md", "")).rejects.toThrow("Folder not found");
	});

	it("legt die Tagesnotiz aus dem Template an und ersetzt {{date}}", async () => {
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026", "Journal/2026/10"],
			files: {
				"Journal/Template/Template.md": "# {{date}}\n\n- [ ] Kimai\n",
				"a.md": "- [x] A\n",
			},
		});

		const result = await drainInto(
			vault,
			vault.getFile("a.md")!,
			"Journal",
			"YYYY/MM/YYYY-MM-DD",
			"Journal/Template/Template.md",
		);

		const content = vault.getFile(result.dailyPath)!.text;
		// {{date}} renders in the note's own format, which is what the core plugin
		// does: here that is "2026/10/2026-10-16", not the plain ISO date.
		expect(content).toContain("# 2026/10/2026-10-16");
		expect(content).toContain("- [ ] Kimai");
		expect(content).toContain("## Erledigt");
		expect(content).toContain("- [x] A");
	});

	it("haengt an eine bereits vorhandene Tagesnotiz an, ohne sie neu zu erzeugen", async () => {
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026", "Journal/2026/10"],
			files: {
				"Journal/2026/10/2026-10-16.md": "# 2026-10-16\n\n## Erledigt\n\n- [x] earlier\n",
				"a.md": "- [x] neu\n",
			},
		});

		const before = vault.createFolderCalls.length;
		const result = await drainInto(vault, vault.getFile("a.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);

		expect(vault.createFolderCalls.length).toBe(before);
		const content = vault.getFile(result.dailyPath)!.text;
		expect(content.match(/## Erledigt/g)).toHaveLength(1);
		expect(content).toContain("- [x] earlier");
		expect(content).toContain("- [x] neu");
		expect(content.indexOf("- [x] neu")).toBeGreaterThan(content.indexOf("- [x] earlier"));
	});

	it("verschiebt eine Canvas-Task und laesst die offene stehen", async () => {
		const canvas = JSON.stringify(
			{
				nodes: [
					{
						id: "a",
						type: "text",
						text: "- [x] erledigt im canvas\n- [ ] offen im canvas",
						x: 1,
						y: 2,
						width: 250,
						height: 60,
					},
				],
				edges: [],
				metadata: { version: "1.0-1.0", frontmatter: {} },
			},
			null,
			"\t",
		);
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026", "Journal/2026/10"],
			files: { "test-area.canvas": canvas },
		});

		const result = await drainInto(
			vault,
			vault.getFile("test-area.canvas")!,
			"Journal",
			"YYYY/MM/YYYY-MM-DD",
			null,
		);

		expect(result.movedCount).toBe(1);
		const after = JSON.parse(vault.getFile("test-area.canvas")!.text);
		expect(after.nodes[0].text).toBe("- [ ] offen im canvas");
		expect(after.nodes[0].x).toBe(1);
		expect(after.nodes[0].width).toBe(250);
		expect(after.metadata.version).toBe("1.0-1.0");
		expect(vault.getFile(result.dailyPath)!.text).toContain("- [x] erledigt im canvas");
	});

	it("blockiert einen Canvas-Parent mit offenem Subtask", async () => {
		const canvas = JSON.stringify({
			nodes: [{ id: "a", type: "text", text: "- [x] P\n    - [ ] Sub" }],
			edges: [],
			metadata: { version: "1.0-1.0", frontmatter: {} },
		});
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026", "Journal/2026/10"],
			files: { "board.canvas": canvas },
		});

		const result = await drainInto(vault, vault.getFile("board.canvas")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);

		expect(result.movedCount).toBe(0);
		expect(JSON.parse(vault.getFile("board.canvas")!.text).nodes[0].text).toBe("- [x] P\n    - [ ] Sub");
	});

	it("schreibt das Ziel vor der Quelle, damit ein Fehler nichts vernichtet", async () => {
		const vault = new FakeVault({
			folders: ["Journal", "Journal/2026", "Journal/2026/10"],
			files: { "a.md": "- [x] A\n" },
		});

		// Fail the source write after the destination was written.
		const original = vault.process.bind(vault);
		vault.process = async (file, fn) => {
			if (file.path === "a.md") throw new Error("Quelle schreibgeschuetzt");
			return original(file, fn);
		};

		await expect(drainInto(vault, vault.getFile("a.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null)).rejects.toThrow(
			"Quelle schreibgeschuetzt",
		);

		// The daily note received the task even though the source failed, which is
		// the intended behaviour: the task is duplicated, never lost.
		expect(vault.getFile("Journal/2026/10/2026-10-16.md")!.text).toContain("- [x] A");
	});

	it("respektiert die Ordner-Ausschlussliste", () => {
		expect(isPathExcluded("Journal/2026/10/2026-10-16.md", SETTINGS.excludedFolders)).toBe(true);
		expect(isPathExcluded("Templates/x.md", SETTINGS.excludedFolders)).toBe(true);
		expect(isPathExcluded("OKF/projekt.md", SETTINGS.excludedFolders)).toBe(false);
	});

	it("ist idempotent: ein zweiter Durchlauf bewegt nichts", async () => {
		const vault = new FakeVault({ files: { "a.md": "- [x] A\n- [x] B\n- [ ] C\n" } });

		const first = await drainInto(vault, vault.getFile("a.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);
		expect(first.movedCount).toBe(2);

		const second = await drainInto(vault, vault.getFile("a.md")!, "Journal", "YYYY/MM/YYYY-MM-DD", null);
		expect(second.movedCount).toBe(0);
	});
});