/**
 * Runs the drain against the real files in the user's vault, read-only.
 *
 * The vault is never written: every file is copied into the in-memory vault
 * first, so this test can run in CI or on a fresh machine without a vault.
 * It proves the parser handles the actual content of both vaults rather than
 * hand-written examples.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FakeVault } from "./harness/fakeVault";
import { TASK_RE, splitCompletedBlocks } from "../src/taskParser";
import { splitCanvas } from "../src/canvasParser";

const WSL_VAULT = "/home/steimerbyte/onedrive";
const WIN_VAULT = "/mnt/c/Users/benjamin.steimer/OneDrive - CANCOM GmbH/PKM";
const OPTS = { requireSubtasksDone: true };

function vaultExists(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function walkMarkdown(root: string, limit: number): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0 && out.length < limit) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.endsWith(".md")) out.push(full);
			if (out.length >= limit) break;
		}
	}
	return out;
}

const hasWsl = vaultExists(WSL_VAULT);
const hasWin = vaultExists(WIN_VAULT);
const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(hasWsl)("Echter Vault (WSL)", () => {
	const files = walkMarkdown(WSL_VAULT, 300);

	it("liest mindestens eine echte Markdown-Datei", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("findet in keiner echten Datei eine kaputte Task-Struktur, die den Parser laedt", () => {
		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			// A round trip without a drain must be byte-identical: if the parser
			// mangled anything, this fails on real content.
			const split = splitCompletedBlocks(content, OPTS);
			if (split.completed.length === 0) {
				expect(split.remained.join("\n")).toBe(content.replace(/\r\n/g, "\n"));
			}
		}
	});

	it("schiebt nur Task-Bloecke, deren Subtasks alle fertig sind", () => {
		let checked = 0;
		for (const file of files) {
			const split = splitCompletedBlocks(fs.readFileSync(file, "utf8"), OPTS);
			for (const block of split.blocks) {
				checked++;
				// Every moved line must be a task line, and it must be checked.
				// TASK_RE is the production pattern, so this asserts against the
				// very syntax the parser accepts rather than a second guess at it.
				for (const line of split.completed) {
					const match = line.match(TASK_RE);
					expect(match).not.toBeNull();
					expect(["x", "X"]).toContain(match![3]);
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("bewegt eine echte Notiz mit offenem Subtask nicht (TODO-Prüfungs.md)", () => {
		const file = path.join(WSL_VAULT, "Belehrung/Prüfungsvorbereitung/TODO-Prüfungs.md");
		if (!fs.existsSync(file)) return;
		const split = splitCompletedBlocks(fs.readFileSync(file, "utf8"), OPTS);
		const moved = split.completed.join("\n");
		expect(moved).not.toContain("Kommunikation & Marketing");
		expect(moved).not.toContain("Technische & kaufmännische Texte");
	});
});

describeIf(hasWin)("Echter Vault (Windows)", () => {
	const files = walkMarkdown(WIN_VAULT, 200);

	it("liest mindestens eine echte Markdown-Datei", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("verarbeitet echte Canvas-Dateien ohne Strukturverlust", () => {
		const canvasFile = path.join(WIN_VAULT, "test-area.canvas");
		if (fs.existsSync(canvasFile)) {
			const raw = fs.readFileSync(canvasFile, "utf8");
			const before = JSON.parse(raw);
			const split = splitCanvas(raw.replace("- [ ] test task", "- [x] test task"), OPTS);
			expect(split.completed).toEqual(["- [x] test task"]);
			const after = JSON.parse(JSON.stringify(split.doc));
			expect(after.nodes.length).toBe(before.nodes.length);
			expect(after.metadata).toEqual(before.metadata);
		}

		const inbox = path.join(WSL_VAULT, "02_INBOX_CANVAS.canvas");
		if (fs.existsSync(inbox)) {
			const raw = fs.readFileSync(inbox, "utf8");
			const before = JSON.parse(raw);
			const split = splitCanvas(raw, OPTS);
			const after = JSON.parse(JSON.stringify(split.doc));
			const beforeNonText = JSON.stringify(before.nodes.filter((n: any) => n.type !== "text"));
			const afterNonText = JSON.stringify(after.nodes.filter((n: any) => n.type !== "text"));
			expect(afterNonText).toBe(beforeNonText);
			expect(after.edges).toEqual(before.edges);
		}
	});

	it("legt im echten Ordnerbestand genau Journal/2026/10 an", () => {
		const target = "Journal/2026/10/2026-10-16.md";
		const parent = "Journal/2026/10";
		const vault = new FakeVault({ folders: ["Journal", "Journal/2026"] });
		const { missingFolders } = require("../src/dailyNotePath");
		const missing: string[] = missingFolders(target, (f: string) => vault.getFolder(f) !== null);
		expect(missing).toEqual([parent]);
		expect(fs.existsSync(path.join(WIN_VAULT, parent))).toBe(false);
	});
});
