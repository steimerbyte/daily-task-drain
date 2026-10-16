/**
 * Pure Markdown task parsing for Daily Task Drain.
 *
 * This module deliberately imports nothing from Obsidian so that every
 * decision it makes can be unit-tested in plain Node.
 *
 * Line numbers in this file refer to the Obsidian task syntax
 * (https://help.obsidian.md/Editing+and+formatting/Task+lists):
 *
 *     - [ ] unchecked
 *     - [x] checked
 *     - [X] checked
 *
 * Nested tasks are children of the task above them, indented further.
 */

/**
 * Bullet character of an unordered list item, or the digits+dot of an ordered
 * one. Non-capturing on purpose: it is embedded in TASK_RE and LIST_ITEM_RE,
 * where a nested group would shift the capture indices of the task pattern.
 */
export const LIST_MARKER = "\\s*(?:[-*+]|\\d+[.)])";

/**
 * Matches a checkbox task line and captures, in order:
 *   1. the leading indentation,
 *   2. the list marker (`-`, `*`, `+`, `1.` or `1)`),
 *   3. the state character (` `, `x` or `X`),
 *   4. the remaining text of the item.
 *
 * The marker is deliberately broader than the classic `/^(\s*)- \[([ xX])\]/`
 * because vaults in the wild use `*`, `+` and ordered lists interchangeably.
 */
export const TASK_RE = new RegExp(`^(\\s*)(${LIST_MARKER})\\s+\\[([ xX])\\]\\s?(.*)$`);

/** Matches any list item, task or not. Used to recognise block boundaries. */
export const LIST_ITEM_RE = new RegExp(`^(\\s*)(?:${LIST_MARKER})\\s`);

/** A Markdown heading: up to six `#` followed by whitespace and a title. */
export const HEADING_RE = /^#{1,6}\s+(.*?)\s*$/;

/** A heading line as a boolean test (used for block/section termination). */
export const HEADING_LINE_RE = /^#{1,6}\s+/;

/** A thematic break: three or more `-`, `*` or `_`, optionally spaced. */
export const THEMATIC_BREAK_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** A line that only holds whitespace. */
const BLANK_RE = /^\s*$/;

/** Index range (inclusive on both ends) of a task and all of its sub-tasks. */
export interface TaskBlock {
	start: number;
	end: number;
}

/** One line of input after classification. */
export interface ParsedLine {
	/** The untouched source line. */
	raw: string;
	/** True when the line is a task AND is not inside frontmatter or a code fence. */
	isTask: boolean;
	/** True when a task line's checkbox is `[x]` or `[X]`. */
	checked: boolean;
	/** Length of the leading whitespace, used for nesting comparisons. */
	indent: number;
}

/** Options controlling which blocks qualify for the move. */
export interface GateOptions {
	/**
	 * When true (the default and the plugin's default setting) a task only
	 * qualifies when every task inside its block is checked. When false only
	 * the task's own checkbox is considered.
	 */
	requireSubtasksDone: boolean;
}

/** Splits text into lines, remembering the line ending so it can be restored. */
export function splitLines(text: string): { lines: string[]; eol: string } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	return { lines: text.split(/\r?\n/), eol };
}

/**
 * Builds a mask of lines that are real Markdown.
 *
 * Frontmatter and fenced code blocks are marked `false` so that task-looking
 * lines inside them are never touched — a `- [x]` inside a shell snippet is
 * documentation, not a task. The mask mirrors the `getMarkdownLineMask`
 * approach of the rollover-plus plugin.
 */
export function markdownLineMask(lines: string[]): boolean[] {
	let fence: string | null = null;
	let frontmatter = (lines[0] ?? "").replace(/^\uFEFF/, "") === "---";

	return lines.map((line, index) => {
		if (frontmatter) {
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) {
				frontmatter = false;
			}
			return false;
		}

		if (fence !== null) {
			const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
			if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
				fence = null;
			}
			return false;
		}

		const opening = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
		if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
			fence = opening[1];
			return false;
		}

		return true;
	});
}

/** Number of leading whitespace characters on a line. */
export function leadingWhitespace(line: string): number {
	const match = line.match(/^\s*/);
	return match ? match[0].length : 0;
}

/** True for `#`-style headings. */
export function isHeading(line: string): boolean {
	return HEADING_LINE_RE.test(line);
}

/** True for `---`, `***` and `___` style thematic breaks. */
export function isThematicBreak(line: string): boolean {
	return THEMATIC_BREAK_RE.test(line);
}

/** True for lines containing nothing but whitespace. */
export function isBlank(line: string): boolean {
	return BLANK_RE.test(line);
}

/** Extracts the text of a heading line, or null when the line is not a heading. */
export function headingText(line: string): string | null {
	const match = line.match(HEADING_RE);
	return match ? match[1] : null;
}

/**
 * Classifies every line as a task line or not.
 *
 * `mask` comes from {@link markdownLineMask}; a masked-out line is never
 * treated as a task even when its text looks like one.
 */
export function parseLines(lines: string[], mask?: boolean[]): ParsedLine[] {
	return lines.map((raw, index) => {
		const masked = mask !== undefined && mask[index] === false;
		const match = masked ? null : raw.match(TASK_RE);
		if (match) {
			const state = match[3];
			return {
				raw,
				isTask: true,
				indent: match[1].length,
				checked: state === "x" || state === "X",
			};
		}
		return { raw, isTask: false, indent: leadingWhitespace(raw), checked: false };
	});
}

/**
 * Returns the index of the last line belonging to the task block that starts at
 * `startIndex`: the task line itself plus every following line indented deeper
 * than it, which is where Obsidian nests its sub-tasks.
 *
 * Headings and thematic breaks terminate a block, blank lines inside it are
 * kept, and trailing blank lines fall outside it.
 */
export function blockEnd(lines: string[], startIndex: number): number {
	const baseIndent = leadingWhitespace(lines[startIndex]);
	let end = startIndex;

	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (isBlank(line)) continue;
		if (isHeading(line) || isThematicBreak(line)) break;
		if (leadingWhitespace(line) > baseIndent) {
			end = i;
		} else {
			break;
		}
	}

	return end;
}

/**
 * Finds every outermost task block in document order. Sub-tasks live inside
 * their parent's block and are therefore not reported separately — that is what
 * lets a parent move together with its children.
 */
export function topLevelBlocks(lines: string[], parsed: ParsedLine[]): TaskBlock[] {
	const blocks: TaskBlock[] = [];
	let i = 0;

	while (i < lines.length) {
		if (parsed[i].isTask) {
			const end = blockEnd(lines, i);
			blocks.push({ start: i, end });
			i = end + 1;
		} else {
			i++;
		}
	}

	return blocks;
}

/**
 * The core rule of this plugin.
 *
 * A block may be moved when its root checkbox is checked AND — unless the
 * caller opted out — every task line inside the block is checked as well.
 * A parent with one open sub-task therefore stays exactly where it is, together
 * with its children.
 */
export function isBlockFullyDone(parsed: ParsedLine[], block: TaskBlock, options: GateOptions): boolean {
	const root = parsed[block.start];
	if (!root || !root.isTask || !root.checked) return false;
	if (!options.requireSubtasksDone) return true;

	for (let i = block.start; i <= block.end; i++) {
		const line = parsed[i];
		if (line && line.isTask && !line.checked) return false;
	}

	return true;
}

/** A heading and the lines that belong to it. */
export interface Section {
	/** Line index of the heading. */
	headingIndex: number;
	/** First line index after the heading. */
	contentStart: number;
	/** Exclusive end: the first line no longer part of the section. */
	contentEnd: number;
}

/**
 * Strips leading `#` markers and surrounding whitespace from a heading
 * setting, leaving the bare title. A setting of `## Erledigt` and one of
 * `Erledigt` therefore address the same section.
 */
export function normalizeHeadingSetting(heading: string): string {
	return heading
		.trim()
		.replace(/^#{1,6}\s*/, "")
		.trim()
		.toLowerCase();
}

/**
 * Locates the section whose heading text equals the configured heading after
 * removing the `#` markers from both sides and lower-casing them.
 *
 * The comparison is exact on purpose: a substring match would also fire on
 * "## Yesterday, done" and drain tasks into the wrong section.
 */
export function findSection(lines: string[], heading: string): Section | null {
	const target = normalizeHeadingSetting(heading);
	if (target.length === 0) return null;

	for (let i = 0; i < lines.length; i++) {
		const text = headingText(lines[i]);
		if (text !== null && text.trim().toLowerCase() === target) {
			let end = lines.length;
			for (let j = i + 1; j < lines.length; j++) {
				if (isHeading(lines[j]) || isThematicBreak(lines[j])) {
					end = j;
					break;
				}
			}
			return { headingIndex: i, contentStart: i + 1, contentEnd: end };
		}
	}

	return null;
}

/**
 * Returns the index after which new entries are inserted: the last non-blank
 * line of the section, or the heading itself when the section is still empty.
 */
export function sectionInsertIndex(lines: string[], section: Section): number {
	let index = section.headingIndex;
	for (let i = section.contentStart; i < section.contentEnd; i++) {
		if (!isBlank(lines[i])) index = i;
	}
	return index;
}

/**
 * Renders the heading to create when a note has no drain section yet.
 *
 * A setting that already carries its own `#` markers is used verbatim, so
 * `## Erledigt` never becomes `## ## Erledigt`. `level` clamps into the legal
 * Markdown range of 1..6 and applies only to a bare setting such as
 * `Erledigt`.
 */
export function renderHeading(heading: string, level: number): string {
	const trimmed = heading.trim();
	if (/^#{1,6}\s+\S/.test(trimmed)) return trimmed;

	const hashes = "#".repeat(Math.min(6, Math.max(1, Math.trunc(level))));
	return `${hashes} ${trimmed}`;
}

/** Result of {@link splitCompletedBlocks}. */
export interface SplitResult {
	/** Lines to append to the daily note, in document order. */
	completed: string[];
	/** Lines that remain in the source note. */
	remained: string[];
	/** The completed blocks, useful for tests and diagnostics. */
	blocks: TaskBlock[];
}

/**
 * Splits a note into the lines that may be drained and the lines that stay.
 *
 * A qualifying block moves as one piece, so a parent never loses its sub-tasks.
 * The remaining lines keep their original text, which means a note without a
 * single qualifying task comes back byte-identical.
 */
export function splitCompletedBlocks(text: string, options: GateOptions): SplitResult {
	const { lines } = splitLines(text);
	const mask = markdownLineMask(lines);
	const parsed = parseLines(lines, mask);
	const blocks = topLevelBlocks(lines, parsed).filter((block) => isBlockFullyDone(parsed, block, options));

	if (blocks.length === 0) {
		return { completed: [], remained: lines, blocks: [] };
	}

	const taken = new Set<number>();
	const completed: string[] = [];
	for (const block of blocks) {
		for (let i = block.start; i <= block.end; i++) {
			taken.add(i);
			completed.push(lines[i]);
		}
	}

	const remained = lines.filter((_, index) => !taken.has(index));

	return { completed, remained, blocks };
}

/**
 * Inserts `entries` at the end of the section named `heading`.
 *
 * When the section does not exist it is created at the end of the document with
 * a blank line before and after it, using `level` for the heading depth.
 */
export function insertIntoSection(
	content: string,
	entries: string[],
	heading: string,
	level: number,
): string {
	if (entries.length === 0) return content;

	const { lines, eol } = splitLines(content);
	const section = findSection(lines, heading);

	if (section === null) {
		const appended = [...lines];
		while (appended.length > 0 && isBlank(appended[appended.length - 1])) appended.pop();
		if (appended.length > 0) appended.push("");
		appended.push(renderHeading(heading, level), "", ...entries, "");
		return appended.join(eol);
	}

	const at = sectionInsertIndex(lines, section);
	const updated = [...lines];
	updated.splice(at + 1, 0, ...entries);
	return updated.join(eol);
}

/** True when the file is worth scanning at all. */
export function isProcessableFile(path: string): boolean {
	return /\.md$/i.test(path);
}

/** Strips surrounding blank lines and re-terminates with a single newline. */
export function tidyContent(lines: string[], eol: string): string {
	const trimmed = [...lines];
	while (trimmed.length > 0 && isBlank(trimmed[trimmed.length - 1])) trimmed.pop();
	if (trimmed.length === 0) return "";
	return trimmed.join(eol) + eol;
}