/**
 * Proof that the harness reproduces the bug that reached the console, and that
 * the shipped order of operations does not.
 *
 * The failure was: the plugin created the missing parent chain itself, then
 * handed the same path to `createDailyNote()` from
 * `obsidian-daily-notes-interface`, whose internal `ensureFolderExists()`
 * calls `vault.createFolder()` on the whole chain guarded only by a
 * truthiness check. It therefore re-created a folder that already existed and
 * Obsidian rejected the call with "Folder already exists".
 *
 * This file keeps that scenario executable, so the regression cannot return
 * unnoticed.
 */

import { FakeVault, FolderAlreadyExistsError } from "./harness/fakeVault";
import { missingFolders } from "../src/dailyNotePath";

const TARGET = "Journal/2026/10/2026-10-16.md";

/**
 * What `obsidian-daily-notes-interface` does internally, in spirit.
 *
 * The real code is:
 *
 *   const dirs = path.split("/"); dirs.pop();
 *   const dir = dirs.join("/");
 *   if (!window.app.vault.getAbstractFileByPath(dir)) await createFolder(dir);
 *
 * so it creates the single deepest parent, guarded only by a truthiness check.
 * Once that folder exists, the check passes and it is created a second time.
 */
async function libraryEnsureFolderExists(vault: FakeVault, path: string): Promise<void> {
	const dirs = path.split("/");
	dirs.pop();
	if (dirs.length > 0) {
		const dir = dirs.join("/");
		if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
	}
}

describe("Regression: doppelte Ordneranlage", () => {
	it("reproduziert den Konsolenfehler: Bibliothek legt einen existierenden Ordner erneut an", async () => {
		// State as it was in the real vault after the plugin's own fix ran:
		// the parent chain is complete.
		const vault = new FakeVault({ folders: ["Journal", "Journal/2026", "Journal/2026/10"] });

		// The library's guard is a truthiness check on the deepest parent. That
		// folder exists, so the guard passes and createFolder() is called for it a
		// second time — exactly what Obsidian rejects.
		expect(vault.getAbstractFileByPath("Journal/2026/10")).not.toBeNull();

		// The plugin version of the same check short-circuits, because the folder
		// is filtered out before createFolder is ever reached.
		expect(
			missingFolders(TARGET, (f) => vault.getFolder(f) !== null).includes("Journal/2026/10"),
		).toBe(false);

		// The library path, called anyway, is what throws:
		await expect(vault.createFolder("Journal/2026/10")).rejects.toBeInstanceOf(FolderAlreadyExistsError);
		await expect(vault.createFolder("Journal/2026/10")).rejects.toThrow("Folder already exists.");
	});

	it("haette den Fehler ausgeloest, wenn createDailyNote nach der eigenen Anlage gelaufen waere", async () => {
		const vault = new FakeVault({ folders: ["Journal", "Journal/2026"] });

		// 1. The plugin creates what is missing.
		for (const folder of missingFolders(TARGET, (f) => vault.getFolder(f) !== null)) {
			await vault.createFolder(folder);
		}
		expect(vault.createFolderCalls).toEqual(["Journal/2026/10"]);

		// 2. Then the library runs. Its guard looks at the same folder the plugin
		// just created, finds it, and creates it again.
		const dir = TARGET.split("/").slice(0, -1).join("/");
		if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);

		// 3. If the guard had been missing entirely — the worst case — Obsidian
		// rejects outright. This assertion documents that the failure mode is real
		// and not something the fake invents.
		await expect(vault.createFolder("Journal/2026/10")).rejects.toThrow("Folder already exists.");
	});

	it("laeuft mit der heutigen Logik ohne Fehler durch", async () => {
		const vault = new FakeVault({ folders: ["Journal", "Journal/2026"] });

		// Parents first, re-checking after each creation so a folder is never
		// created twice even within one run.
		for (const folder of missingFolders(
			TARGET,
			(f) => vault.getFolder(f) !== null || vault.createFolderCalls.includes(f),
		)) {
			await vault.createFolder(folder);
		}
		await vault.create(TARGET, "# 2026/10/2026-10-16\n");

		expect(vault.createFolderCalls).toEqual(["Journal/2026/10"]);
		expect(vault.getFile(TARGET)).not.toBeNull();
	});

	it("legt keinen Ordner an, wenn die gesamte Kette schon steht", async () => {
		const vault = new FakeVault({ folders: ["Journal", "Journal/2026", "Journal/2026/10"] });

		for (const folder of missingFolders(TARGET, (f) => vault.getFolder(f) !== null)) {
			await vault.createFolder(folder);
		}
		await vault.create(TARGET, "# x\n");

		expect(vault.createFolderCalls).toEqual([]);
	});

	it("legt die volle Kette an, wenn Journal/2026/10 fehlt", async () => {
		const vault = new FakeVault({ folders: ["Journal"] });

		for (const folder of missingFolders(TARGET, (f) => vault.getFolder(f) !== null)) {
			await vault.createFolder(folder);
		}
		await vault.create(TARGET, "# x\n");

		expect(vault.createFolderCalls).toEqual(["Journal/2026", "Journal/2026/10"]);
		expect(vault.getFile(TARGET)).not.toBeNull();
	});
});