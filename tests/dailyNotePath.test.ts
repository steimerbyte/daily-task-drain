import { missingFolders, parentOf } from "../src/dailyNotePath";

/**
 * Regression tests for the bug where a drain failed with "folder already
 * exists" style errors: the daily-notes settings carry a vault-level folder
 * ("Journal") while the format adds sub-folders ("YYYY/MM/YYYY-MM-DD"). Creating
 * only "Journal" left "Journal/2026/10" missing in a vault that had never seen
 * October, and the file creation then failed on the absent parent.
 */

const OCTOBER_NOTE = "Journal/2026/10/2026-10-16.md";
const FLAT_NOTE = "2026-10-16.md";

function vaultWith(folders: string[]): (folder: string) => boolean {
	const known: Record<string, true> = {};
	for (const folder of folders) known[folder] = true;
	return (folder: string) => known[folder] === true;
}

describe("parentOf", () => {
	it("liefert den Elternordner eines verschachtelten Pfads", () => {
		expect(parentOf(OCTOBER_NOTE)).toBe("Journal/2026/10");
	});

	it("liefert einen leeren String fuer eine Datei im Vault-Root", () => {
		expect(parentOf(FLAT_NOTE)).toBe("");
	});
});

describe("missingFolders", () => {
	it("erzeugt die komplette Kette, wenn kein Ordner existiert", () => {
		expect(missingFolders(OCTOBER_NOTE, vaultWith([]))).toEqual([
			"Journal",
			"Journal/2026",
			"Journal/2026/10",
		]);
	});

	it("erzeugt nur den fehlenden Oktober-Ordner, wenn Journal schon existiert", () => {
		// Das ist exakt der gemeldete Fall.
		expect(missingFolders(OCTOBER_NOTE, vaultWith(["Journal", "Journal/2026"]))).toEqual([
			"Journal/2026/10",
		]);
	});

	it("erzeugt nichts, wenn die gesamte Kette schon steht", () => {
		const full = vaultWith(["Journal", "Journal/2026", "Journal/2026/10"]);
		expect(missingFolders(OCTOBER_NOTE, full)).toEqual([]);
	});

	it("erzeugt bei einer flachen Konfiguration gar nichts", () => {
		expect(missingFolders(FLAT_NOTE, vaultWith([]))).toEqual([]);
	});

	it("liefert Eltern vor Kindern, damit jede Anlage getragen ist", () => {
		const chain = missingFolders(OCTOBER_NOTE, vaultWith([]));
		for (let i = 1; i < chain.length; i++) {
			expect(chain[i].startsWith(`${chain[i - 1]}/`)).toBe(true);
		}
	});

	it("faellt von einem vorhandenen Zwischenordner nicht auf eine falsche Ebene zurueck", () => {
		// Journal/2026 existiert, Journal/2026/10 nicht: die Liste muss genau den
		// einen fehlenden Ordner nennen und nicht Journal noch einmal.
		const result = missingFolders(OCTOBER_NOTE, vaultWith(["Journal", "Journal/2026"]));
		expect(result).not.toContain("Journal");
		expect(result).toHaveLength(1);
	});
});