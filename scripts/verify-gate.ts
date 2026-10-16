import * as fs from "node:fs";
import * as path from "node:path";
import {
	splitCompletedBlocks,
	insertIntoSection,
	type GateOptions,
} from "../src/taskParser";

/**
 * Gate-Verifikation gegen echte Vault-Dateien und die reale API des Parsers.
 * Ersetzt die Skizze, die ich zuerst gegen geratene Signaturen geschrieben hatte.
 */
const VAULT = "/home/steimerbyte/onedrive";
const OPTS: GateOptions = { requireSubtasksDone: true };

let checked = 0;
let failures = 0;

function expect(label: string, actual: boolean, want: boolean) {
	checked++;
	const ok = actual === want;
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (erwartet ${want}, ist ${actual})`);
}

function drains(content: string, opts: GateOptions = OPTS): boolean {
	return splitCompletedBlocks(content, opts).completed.length > 0;
}

// --- Echte Vault-Dateien ---
// TODO-Prüfungs.md Z.48 ist ein `[x]`-Parent, darunter zwei offene Subtasks.
// Dieser Parent muss stehen bleiben.
const withOpenSubs = fs.readFileSync(
	path.join(VAULT, "Belehrung/Prüfungsvorbereitung/TODO-Prüfungs.md"),
	"utf8"
);
{
	const r = splitCompletedBlocks(withOpenSubs, OPTS);
	const moved = r.completed.join("\n");
	expect(
		"echter Parent mit offenen Subtasks bleibt in der Quelle",
		moved.includes("Kommunikation & Marketing"),
		false
	);
	expect(
		"offene Subtask-Zeile wird nie mitverschoben",
		moved.includes("Technische & kaufmännische Texte"),
		false
	);
}

// agent-pc-pi-agent-install.md hat drei eigenstaendige fertige Tasks (Z.18-20)
// und eine offene (Z.21). Die drei fertigen muessen fliessen, die offene nicht.
const mixed = fs.readFileSync(
	path.join(VAULT, "OKF/playbooks/agent-pc-pi-agent-install.md"),
	"utf8"
);
{
	const r = splitCompletedBlocks(mixed, OPTS);
	const moved = r.completed.join("\n");
	const stayed = r.remained.join("\n");
	expect("drei eigenstaendige fertige Tasks fliessen", r.completed.length, 3);
	expect("die offene Task bleibt stehen", stayed.includes("Quell-Filter geklärt"), true);
}

const allDone = fs.readFileSync(
	path.join(VAULT, "OKF/research/Planets/Arbeit/Rubrik/Rubrik-Research-Plan.md"),
	"utf8"
);
expect("echte Vault-Datei mit fertigen Tasks WIRD verschoben", drains(allDone), true);

// --- Gate-Faelle ---
const cases: Array<[string, string, boolean]> = [
	["Parent + alle Subtasks fertig", "- [x] P\n    - [x] A\n    - [x] B\n", true],
	["Parent fertig, ein Subtask offen", "- [x] P\n    - [x] A\n    - [ ] B\n", false],
	["Parent fertig, erster Subtask offen", "- [x] P\n    - [ ] A\n    - [x] B\n", false],
	["tief verschachtelt, tiefster offen", "- [x] P\n    - [x] A\n        - [ ] tief\n", false],
	["Subtask nicht als Task (Prosa)", "- [x] P\n    - [ ] A\n    - erweiterung ohne checkbox\n", false],
	["Task in Code-Fence ignoriert", "```\n- [x] schein\n```\n", false],
	["Fence + echte Task: nur echte zaehlt", "```\n- [x] fence\n```\n- [x] real\n", true],
	["tilde-Fence ignoriert", "~~~\n- [x] schein\n~~~\n", false],
	["Tab-Einrueckung als Subtask", "- [x] P\n\t- [ ] offen\n", false],
	["Tab-Einrueckung fertig", "- [x] P\n\t- [x] fertig\n", true],
	["nummerierte Liste", "1. [x] nummeriert\n", true],
	["Stern-Marker", "* [x] stern\n", true],
	["Plus-Marker", "+ [x] plus\n", true],
	["X statt x", "- [X] gross\n", true],
	["kleinbuchstabe x", "- [x] klein\n", true],
	["Wurzel nicht erledigt", "- [ ] P\n    - [x] Sub\n", false],
	["zwei Tasks, einer blockiert", "- [x] gut\n- [ ] schlecht\n", true],
	["leere Datei", "", false],
	["nur Prosa", "keine Tasks hier\n", false],
	["Frontmatter mit Task-Zeilen ignoriert", "---\ntags: [x] nicht really\n---\n", false],
];

for (const [label, content, want] of cases) {
	expect(label, drains(content), want);
}

// Option requireSubtasksDone=false muss Parent trotz offenem Subtask durchlassen
expect(
	"Option aus: Parent mit offenem Subtask fliesst",
	drains("- [x] P\n    - [ ] A\n", { requireSubtasksDone: false }),
	true
);

// --- Integritaet: Quelle verliert exakt die verschobenen Zeilen ---
{
	const src = "# Projekt\n\n- [ ] offen\n\n- [x] P\n    - [x] A\n\n## Ende\n";
	const r = splitCompletedBlocks(src, OPTS);
	expect("nur der fertige Block verschiebt sich", r.completed.length, 2);
	expect(
		"offene und leere Zeilen bleiben in der Quelle",
		r.remained.join("\n"),
		"# Projekt\n\n- [ ] offen\n\n\n## Ende\n"
	);
}

// --- Zwei Blöcke, beide fertig ---
{
	const src = "- [x] A\n- [x] B\n";
	const r = splitCompletedBlocks(src, OPTS);
	expect("beide Tasks verschieben sich", r.completed.length, 2);
	expect("Quelle ist danach leer", r.remained.filter((l) => l.trim() !== "").length, 0);
}

// --- Idempotenz: zweiter Durchlauf darf nichts mehr finden ---
{
	let content = "- [x] A\n    - [x] Sub\n- [ ] B\n";
	const first = splitCompletedBlocks(content, OPTS);
	expect("erster Durchlauf verschiebt 2 Zeilen", first.completed.length, 2);
	const second = splitCompletedBlocks(first.remained.join("\n"), OPTS);
	expect("zweiter Durchlauf verschiebt nichts mehr", second.completed.length, 0);
}

// --- Insertion: Heading wird erzeugt, dann wiederverwendet ---
{
	const daily = "# 2026-10-16\n\nNotizen des Tages.\n";
	const after = insertIntoSection(daily, ["- [x] P"], "## Erledigt", 2);
	expect("Heading wird genau einmal erzeugt", after.match(/## Erledigt/g)?.length, 1);
	expect("Task steht unter dem Heading", after.indexOf("## Erledigt") < after.indexOf("- [x] P"), true);

	const again = insertIntoSection(after, ["- [x] Q"], "## Erledigt", 2);
	expect("zweites Heading wird NICHT erzeugt", again.match(/## Erledigt/g)?.length, 1);

	const third = insertIntoSection(again, ["- [x] R"], "## Erledigt", 2);
	expect("dritter Task haengt hinten an", third.indexOf("- [x] R") > third.indexOf("- [x] Q"), true);
}

// --- Insertion: bestehendes Heading weiter unten wird erkannt ---
{
	const daily = "# Tag\n\n## Erledigt\n\n- [x] alt\n\n## Notizen\n\nText\n";
	const after = insertIntoSection(daily, ["- [x] neu"], "## Erledigt", 2);
	expect("kein zweites Heading trotz spaeterem Notizen-Heading", after.match(/## Erledigt/g)?.length, 1);
	expect(
		"neuer Task landet in der Erledigt-Sektion, nicht unter Notizen",
		after.indexOf("- [x] neu") < after.indexOf("## Notizen"),
		true
	);
}

console.log(`\n${checked} Pruefungen, ${failures} Fehler`);
process.exit(failures === 0 ? 0 : 1);