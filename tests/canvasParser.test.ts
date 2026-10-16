import {
	parseCanvas,
	splitCanvas,
	splitCanvasNode,
	stringifyCanvas,
	isCanvasPath,
	type CanvasNode,
	type CanvasSplit,
} from "../src/canvasParser";
import type { GateOptions } from "../src/taskParser";

const OPTS: GateOptions = { requireSubtasksDone: true };

function canvasWith(nodes: unknown[], rest: Record<string, unknown> = {}): string {
	return JSON.stringify({ nodes, edges: [], ...rest }, null, "\t");
}

function textNode(id: string, text: string, extra: Record<string, unknown> = {}): CanvasNode {
	return { id, type: "text", text, x: 0, y: 0, width: 250, height: 60, ...extra };
}

function nodeText(result: CanvasSplit, id: string): string | undefined {
	return result.doc.nodes.find((n) => n.id === id)?.text;
}

describe("isCanvasPath", () => {
	it("erkennt .canvas unabhaengig von der Grossschreibung", () => {
		expect(isCanvasPath("a/b.canvas")).toBe(true);
		expect(isCanvasPath("a/b.CANVAS")).toBe(true);
	});

	it("lehnt Markdown und alles andere ab", () => {
		expect(isCanvasPath("a/b.md")).toBe(false);
		expect(isCanvasPath("a/canvas.md")).toBe(false);
		expect(isCanvasPath("a/b.canvas.md")).toBe(false);
	});
});

describe("parseCanvas", () => {
	it("liest ein gueltiges Canvas", () => {
		expect(parseCanvas(canvasWith([textNode("a", "x")]))).not.toBeNull();
	});

	it("liefert null bei kaputtem JSON", () => {
		expect(parseCanvas("{not json")).toBeNull();
	});

	it("liefert null wenn nodes kein Array ist", () => {
		expect(parseCanvas('{"nodes":{}}')).toBeNull();
	});

	it("liefert null bei einem JSON-Array statt Objekt", () => {
		expect(parseCanvas("[]")).toBeNull();
	});

	it("liefert null bei JSON ohne nodes, damit nichts zerstoert wird", () => {
		expect(parseCanvas('{"foo":"bar"}')).toBeNull();
		expect(parseCanvas('"nur ein string"')).toBeNull();
		expect(parseCanvas("null")).toBeNull();
	});
});

describe("splitCanvasNode", () => {
	it("verschiebt eine fertige Task und laesst den Rest stehen", () => {
		const node = textNode("n1", "- [x] fertig\n- [ ] offen");
		const r = splitCanvasNode(node, OPTS);
		expect(r.completed).toEqual(["- [x] fertig"]);
		expect(r.remainedText).toBe("- [ ] offen");
		expect(r.unchanged).toBe(false);
	});

	it("meldet unchanged bei nur offenen Tasks", () => {
		const r = splitCanvasNode(textNode("n1", "- [ ] offen"), OPTS);
		expect(r.unchanged).toBe(true);
		expect(r.completed).toEqual([]);
		expect(r.remainedText).toBe("- [ ] offen");
	});

	it("blockiert Parent mit offenem Subtask", () => {
		const r = splitCanvasNode(textNode("n1", "- [x] P\n    - [x] A\n    - [ ] B"), OPTS);
		expect(r.unchanged).toBe(true);
	});

	it("verschiebt Parent mit fertigen Subtasks als Block", () => {
		const r = splitCanvasNode(textNode("n1", "- [x] P\n    - [x] A\n    - [x] B"), OPTS);
		expect(r.completed).toEqual(["- [x] P", "    - [x] A", "    - [x] B"]);
		expect(r.remainedText).toBe("");
	});

	it("laesst Prosa um die Tasks herum unberuehrt", () => {
		const r = splitCanvasNode(textNode("n1", "Notiz\n\n- [x] A\n\nEnde"), OPTS);
		expect(r.completed).toEqual(["- [x] A"]);
		expect(r.remainedText).toBe("Notiz\n\n\nEnde");
	});

	it("ignoriert Tasks in Code-Fences", () => {
		const r = splitCanvasNode(textNode("n1", "```\n- [x] schein\n```"), OPTS);
		expect(r.unchanged).toBe(true);
	});

	it("faellt auf leere Texte fuer file-, group- und link-Knoten zurueck", () => {
		const file = { id: "f", type: "file", file: "a.md" } as CanvasNode;
		expect(splitCanvasNode(file, OPTS).unchanged).toBe(true);

		const group = { id: "g", type: "group", label: "G" } as CanvasNode;
		expect(splitCanvasNode(group, OPTS).unchanged).toBe(true);

		const link = { id: "l", type: "link", url: "https://x" } as CanvasNode;
		expect(splitCanvasNode(link, OPTS).unchanged).toBe(true);
	});
});

describe("splitCanvas", () => {
	it("verarbeitet mehrere Knoten und sammelt alle Tasks", () => {
		const src = canvasWith([
			textNode("a", "- [x] eins"),
			textNode("b", "- [ ] zwei"),
			textNode("c", "- [x] drei\n- [ ] vier"),
		]);
		const r = splitCanvas(src, OPTS);
		expect(r.completed).toEqual(["- [x] eins", "- [x] drei"]);
		expect(r.changedNodes).toBe(2);
		expect(nodeText(r, "a")).toBe("");
		expect(nodeText(r, "b")).toBe("- [ ] zwei");
		expect(nodeText(r, "c")).toBe("- [ ] vier");
	});

	it("meldet Knoten, die ihren gesamten Inhalt verloren haben", () => {
		const r = splitCanvas(canvasWith([textNode("a", "- [x] nur das")]), OPTS);
		expect(r.emptiedNodeIds).toEqual(["a"]);
	});

	it("behaelt alle Felder eines Knotens ausser text unveraendert", () => {
		const node = textNode("a", "- [x] A", {
			color: "4",
			styleAttributes: { bold: true },
			vn: "visnet",
		});
		const r = splitCanvas(canvasWith([node]), OPTS);
		const after = r.doc.nodes[0];
		expect(after.color).toBe("4");
		expect(after.styleAttributes).toEqual({ bold: true });
		expect(after.vn).toBe("visnet");
		expect(after.x).toBe(0);
		expect(after.width).toBe(250);
	});

	it("erhaelt edges und metadata unangetastet", () => {
		const src = canvasWith([textNode("a", "- [x] A")], {
			metadata: { version: "1.0-1.0", frontmatter: { tags: "wichtig" } },
		});
		const r = splitCanvas(src, OPTS);
		expect(r.doc.edges).toEqual([]);
		expect(r.doc.metadata).toEqual({ version: "1.0-1.0", frontmatter: { tags: "wichtig" } });
	});

	it("aendert gar nichts, wenn keine Task qualifiziert", () => {
		const src = canvasWith([textNode("a", "- [ ] offen")], { metadata: { version: "1.0-1.0" } });
		const r = splitCanvas(src, OPTS);
		expect(r.completed).toEqual([]);
		expect(r.changedNodes).toBe(0);
		expect(stringifyCanvas(r.doc)).toBe(stringifyCanvas(JSON.parse(src)));
	});

	it("liefert bei kaputtem JSON nichts zum Verschieben", () => {
		const r = splitCanvas("{kaputt", OPTS);
		expect(r.completed).toEqual([]);
		expect(r.changedNodes).toBe(0);
	});

	it("ist idempotent: zweiter Durchlauf findet nichts", () => {
		const src = canvasWith([textNode("a", "- [x] A\n- [x] B\n- [ ] C")]);
		const first = splitCanvas(src, OPTS);
		expect(first.completed.length).toBe(2);

		const second = splitCanvas(stringifyCanvas(first.doc), OPTS);
		expect(second.completed).toEqual([]);
		expect(second.changedNodes).toBe(0);
	});

	it("behaelt die Reihenfolge der Knoten bei", () => {
		const src = canvasWith([
			textNode("z", "- [x] Z"),
			{ id: "m", type: "group", label: "G" } as CanvasNode,
			textNode("a", "- [x] A"),
		]);
		const r = splitCanvas(src, OPTS);
		expect(r.doc.nodes.map((n) => n.id)).toEqual(["z", "m", "a"]);
		expect(r.completed).toEqual(["- [x] Z", "- [x] A"]);
	});

	it("verarbeitet die echte test-area.canvas aus dem Vault", () => {
		const src = `{
	"nodes":[
		{
			"id":"235f061c0e8d180b",
			"type":"text",
			"text":"- [x] test task",
			"styleAttributes":{},
			"x":-220,
			"y":-300,
			"width":260,
			"height":60
		}
	],
	"edges":[],
	"metadata":{
		"version":"1.0-1.0",
		"frontmatter":{}
	}
}`;
		const r = splitCanvas(src, OPTS);
		expect(r.completed).toEqual(["- [x] test task"]);
		expect(r.changedNodes).toBe(1);
		expect(r.emptiedNodeIds).toEqual(["235f061c0e8d180b"]);
		expect(r.doc.nodes[0].styleAttributes).toEqual({});
		expect(r.doc.nodes[0].x).toBe(-220);
	});

	it("laesst eine offene Task in test-area.canvas unberuehrt", () => {
		const src = JSON.stringify({
			nodes: [{ id: "a", type: "text", text: "- [ ] test task" }],
			edges: [],
			metadata: { version: "1.0-1.0", frontmatter: {} },
		});
		const r = splitCanvas(src, OPTS);
		expect(r.completed).toEqual([]);
		expect(nodeText(r, "a")).toBe("- [ ] test task");
	});
});