/**
 * Canvas support for Daily Task Drain.
 *
 * A `.canvas` file is JSON, not Markdown, so the Markdown parser in
 * `taskParser.ts` cannot see into it. Obsidian stores a canvas as a set of
 * nodes, and the ones that can hold tasks are the `text` nodes, whose `text`
 * field is a fragment of Markdown.
 *
 * This module therefore reuses the very same gate from `taskParser.ts` on the
 * text of every text node, and reports what has to change in the JSON.
 *
 * Like `taskParser.ts` this module imports nothing from Obsidian, so the whole
 * decision logic stays testable in plain Node.
 */

import { GateOptions, splitCompletedBlocks } from "./taskParser";

/** The node types this plugin can do something with. */
const TEXT_NODE = "text";

/** File extension of an Obsidian canvas. */
export const CANVAS_EXTENSION = ".canvas";

/** True for a path that is a canvas file. */
export function isCanvasPath(path: string): boolean {
	return /\.canvas$/i.test(path);
}

/**
 * The parts of a canvas node this module reads or writes. Declaring only what
 * is needed keeps the plugin from dropping fields it does not understand, such
 * as `color`, `styleAttributes`, `vn` or the layout keys of group nodes.
 */
export interface CanvasNode {
	id: string;
	type: string;
	text?: string;
	[key: string]: unknown;
}

/** A canvas document, reduced to the parts this module touches. */
export interface CanvasDoc {
	nodes: CanvasNode[];
	edges?: unknown[];
	[key: string]: unknown;
}

/** One text node after the gate was applied. */
export interface CanvasNodeSplit {
	/** The node as it was. */
	node: CanvasNode;
	/** Lines of this node that may be drained, in document order. */
	completed: string[];
	/** The node's text after the completed lines were removed. */
	remainedText: string;
	/** True when nothing qualifies in this node and it stays untouched. */
	unchanged: boolean;
}

/** Outcome of running the gate over a whole canvas. */
export interface CanvasSplit {
	/** All task lines that move to the daily note, in canvas node order. */
	completed: string[];
	/** The canvas document with the completed lines removed from its nodes. */
	doc: CanvasDoc;
	/** How many nodes actually changed. */
	changedNodes: number;
	/**
	 * Nodes that lost all of their content. A canvas node without text renders
	 * as an empty box, so the caller should decide what to do with them; this
	 * plugin keeps them and only reports them.
	 */
	emptiedNodeIds: string[];
}

/** True when a node carries Markdown text this plugin can read. */
function isTextNode(node: CanvasNode): boolean {
	return node.type === TEXT_NODE && typeof node.text === "string" && node.text.length > 0;
}

/** Parses canvas JSON, returning null when the file is not readable as canvas. */
export function parseCanvas(content: string): CanvasDoc | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}

	// A canvas is an object with a `nodes` array. Anything else is either broken
	// or a different JSON file that happens to carry the .canvas extension, and
	// writing to it would destroy its content.
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const nodes = (parsed as CanvasDoc).nodes;
	if (!Array.isArray(nodes)) return null;

	return parsed as CanvasDoc;
}

/**
 * Applies the gate to a single node's text.
 *
 * Returns `unchanged: true` for a node the plugin must not write at all, so
 * that nodes which keep their exact original bytes are never serialised again.
 */
export function splitCanvasNode(node: CanvasNode, options: GateOptions): CanvasNodeSplit {
	const text = typeof node.text === "string" ? node.text : "";

	if (!isTextNode(node)) {
		return { node, completed: [], remainedText: text, unchanged: true };
	}

	const { completed, remained } = splitCompletedBlocks(text, options);

	if (completed.length === 0) {
		return { node, completed: [], remainedText: text, unchanged: true };
	}

	// join("") rather than join("\n"): splitCompletedBlocks drops the empty
	// trailing element that splitLines adds, so re-joining the remaining lines
	// with newlines is what restores the node's line structure.
	const remainedText = remained.join("\n").replace(/\n+$/, "");

	return { node, completed, remainedText, unchanged: false };
}

/**
 * Runs the gate over every text node of a canvas.
 *
 * The document is only copied once a node really changes, so a canvas without a
 * single qualifying task comes back as the same object the caller passed in.
 */
export function splitCanvas(content: string, options: GateOptions): CanvasSplit {
	const doc = parseCanvas(content);

	if (doc === null) {
		return { completed: [], doc: { nodes: [] }, changedNodes: 0, emptiedNodeIds: [] };
	}

	const completed: string[] = [];
	const emptiedNodeIds: string[] = [];
	let changedNodes = 0;

	const nodes = doc.nodes.map((node) => {
		const split = splitCanvasNode(node, options);
		if (split.unchanged) return node;

		completed.push(...split.completed);
		changedNodes++;

		if (split.remainedText.trim().length === 0) emptiedNodeIds.push(node.id);

		// Shallow copy of the node: only `text` changes, every other key is
		// carried over untouched so layout, colour and plugin metadata survive.
		return { ...node, text: split.remainedText };
	});

	if (changedNodes === 0) {
		return { completed: [], doc, changedNodes: 0, emptiedNodeIds: [] };
	}

	return { completed, doc: { ...doc, nodes }, changedNodes, emptiedNodeIds };
}

/** Serialises a canvas document. */
export function stringifyCanvas(doc: CanvasDoc): string {
	return `${JSON.stringify(doc, null, "\t")}\n`;
}