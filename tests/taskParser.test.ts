import {
	GateOptions,
	SplitResult,
	TaskBlock,
	blockEnd,
	findSection,
	insertIntoSection,
	isBlockFullyDone,
	markdownLineMask,
	parseLines,
	sectionInsertIndex,
	splitCompletedBlocks,
	splitLines,
	topLevelBlocks,
	tidyContent,
} from "../src/taskParser";

const strict: GateOptions = { requireSubtasksDone: true };
const loose: GateOptions = { requireSubtasksDone: false };

/** Parses a note and returns the classified lines together with the raw ones. */
function analyse(text: string) {
	const { lines } = splitLines(text);
	const parsed = parseLines(lines, markdownLineMask(lines));
	return { lines, parsed };
}

/** Convenience: every block of a note that passes the gate. */
function doneBlocks(text: string, options: GateOptions = strict): TaskBlock[] {
	const { lines, parsed } = analyse(text);
	return topLevelBlocks(lines, parsed).filter((block) => isBlockFullyDone(parsed, block, options));
}

describe("splitLines", () => {
	it("keeps CRLF line endings apart from the content", () => {
		const { lines, eol } = splitLines("- [ ] a\r\n- [x] b\r\n");
		expect(lines).toEqual(["- [ ] a", "- [x] b", ""]);
		expect(eol).toBe("\r\n");
	});

	it("defaults to LF", () => {
		expect(splitLines("a\nb").eol).toBe("\n");
	});
});

describe("task recognition", () => {
	it("accepts every bullet character Obsidian allows", () => {
		const { parsed } = analyse("- [x] dash\n* [x] star\n+ [x] plus\n1. [x] ordered\n1) [x] ordered paren\n");
		expect(parsed.map((line) => line.isTask)).toEqual([true, true, true, true, true, false]);
	});

	it("only counts x and X as done", () => {
		const { parsed } = analyse("- [x] small\n- [X] capital\n- [ ] open\n- [] empty\n- [q] unknown\n");
		expect(parsed.map((line) => line.checked)).toEqual([true, true, false, false, false, false]);
	});

	it("does not treat ordinary list items as tasks", () => {
		const { parsed } = analyse("- plain\n* plain too\n1. numbered\n");
		expect(parsed.every((line) => !line.isTask)).toBe(true);
	});

	it("measures indentation with tabs and spaces alike", () => {
		const { parsed } = analyse("- [x] parent\n\t- [x] tabbed\n    - [x] spaced\n");
		expect(parsed.map((line) => line.indent)).toEqual([0, 1, 4, 0]);
	});
});

describe("markdownLineMask", () => {
	it("masks frontmatter", () => {
		const mask = markdownLineMask(splitLines("---\ntitle: x\n---\n- [x] real\n").lines);
		expect(mask).toEqual([false, false, false, true, true]);
	});

	it("masks fenced code blocks with backticks and tildes", () => {
		const mask = markdownLineMask(splitLines("```\n- [x] sample\n```\n- [x] real\n").lines);
		expect(mask).toEqual([false, false, false, true, true]);
	});

	it("closes a tilde fence on a matching tilde fence", () => {
		const mask = markdownLineMask(splitLines("~~~\n- [x] sample\n~~~\n- [x] real\n").lines);
		expect(mask).toEqual([false, false, false, true, true]);
	});

	it("requires the closing fence to be at least as long as the opening one", () => {
		const mask = markdownLineMask(splitLines("````\n```\n- [x] still code\n````\n- [x] real\n").lines);
		expect(mask).toEqual([false, false, false, false, true, true]);
	});

	it("does not treat an info string containing a backtick as a fence", () => {
		const mask = markdownLineMask(splitLines("```a`b\n- [x] real\n").lines);
		expect(mask).toEqual([true, true, true]);
	});
});

describe("code fences are never drained", () => {
	it("leaves task-looking lines inside a code block alone", () => {
		const note = ["```bash", "- [x] git commit", "```", "", "- [x] Real task", ""].join("\n");
		const { lines, parsed } = analyse(note);

		expect(parsed[1].isTask).toBe(false);
		expect(doneBlocks(note)).toHaveLength(1);
		expect(doneBlocks(note)[0].start).toBe(4);
	});

	it("leaves task-looking lines inside frontmatter alone", () => {
		const note = ["---", "- [x]: metadata", "---", "", "- [x] Real task", ""].join("\n");
		expect(doneBlocks(note).map((block) => block.start)).toEqual([4]);
	});
});

describe("blockEnd", () => {
	it("stops at the first line that is not indented deeper", () => {
		const { lines } = analyse("- [x] a\n    - [x] b\n- [ ] c\n");
		expect(blockEnd(lines, 0)).toBe(1);
	});

	it("keeps internal blank lines but ends the block before trailing ones", () => {
		const { lines } = analyse("- [x] a\n\n    - [x] b\n\n- [ ] c\n");
		expect(blockEnd(lines, 0)).toBe(2);
	});

	it("ends the block at a heading", () => {
		const { lines } = analyse("- [x] a\n\n## Next\n    indented but cut off\n");
		expect(blockEnd(lines, 0)).toBe(0);
	});

	it("ends the block at a thematic break", () => {
		const { lines } = analyse("- [x] a\n---\n    after the break\n");
		expect(blockEnd(lines, 0)).toBe(0);
	});

	it("collects deeply nested sub-tasks", () => {
		const { lines } = analyse("- [x] a\n  - [x] b\n    - [x] c\n    - [x] d\n  - [x] e\n");
		expect(blockEnd(lines, 0)).toBe(4);
	});
});

describe("topLevelBlocks", () => {
	it("does not report nested sub-tasks separately", () => {
		const { lines, parsed } = analyse("- [ ] parent\n    - [x] child\n- [x] sibling\n");
		expect(topLevelBlocks(lines, parsed)).toEqual([
			{ start: 0, end: 1 },
			{ start: 2, end: 2 },
		]);
	});
});

describe("the gate: task and all sub-tasks done", () => {
	it("moves a plain completed task", () => {
		expect(doneBlocks("- [x] Parent\n")).toHaveLength(1);
	});

	it("moves a parent whose sub-tasks are all done", () => {
		const note = ["- [x] Parent", "    - [x] Sub A", "    - [x] Sub B", ""].join("\n");
		const blocks = doneBlocks(note);
		expect(blocks).toEqual([{ start: 0, end: 2 }]);
	});

	it("blocks a parent with one open sub-task", () => {
		const note = ["- [x] Parent", "    - [x] Sub A", "    - [ ] Sub B", ""].join("\n");
		expect(doneBlocks(note)).toHaveLength(0);
	});

	it("blocks an unchecked parent even when every sub-task is done", () => {
		const note = ["- [ ] Parent", "    - [x] Sub A", "    - [x] Sub B", ""].join("\n");
		expect(doneBlocks(note)).toHaveLength(0);
	});

	it("blocks deeply nested open sub-tasks", () => {
		const note = ["- [x] Parent", "  - [x] Sub A", "    - [ ] Sub B", ""].join("\n");
		expect(doneBlocks(note)).toHaveLength(0);
	});

	it("works with tabs as indentation", () => {
		const note = ["- [x] Parent", "\t- [x] Sub A", "\t- [ ] Sub B", ""].join("\n");
		expect(doneBlocks(note)).toHaveLength(0);
	});

	it("works with ordered sub-tasks", () => {
		const note = ["- [x] Parent", "    1. [x] Sub A", "    2. [ ] Sub B", ""].join("\n");
		expect(doneBlocks(note)).toHaveLength(0);
	});

	it("moves the parent when the setting is switched off", () => {
		const note = ["- [x] Parent", "    - [x] Sub A", "    - [ ] Sub B", ""].join("\n");
		expect(doneBlocks(note, loose)).toHaveLength(1);
	});

	it("handles CRLF notes identically", () => {
		const note = "- [x] Parent\r\n    - [x] Sub A\r\n    - [ ] Sub B\r\n";
		expect(doneBlocks(note)).toHaveLength(0);
	});
});

describe("splitCompletedBlocks", () => {
	/** Renders what the source note would look like after the drain. */
	function remaining(result: SplitResult, eol = "\n"): string {
		return tidyContent(result.remained, eol);
	}

	it("separates finished blocks from the rest of the note", () => {
		const note = ["# Note", "", "- [ ] Open", "- [x] Done", "", "Text", ""].join("\n");
		const result = splitCompletedBlocks(note, strict);

		expect(result.completed).toEqual(["- [x] Done"]);
		expect(remaining(result)).toBe(["# Note", "", "- [ ] Open", "", "Text", ""].join("\n"));
	});

	it("keeps the parent and its sub-tasks together in the moved block", () => {
		const note = ["- [x] Parent", "    - [x] Sub A", "    - [x] Sub B", "- [ ] Open", ""].join("\n");
		const result = splitCompletedBlocks(note, strict);

		expect(result.completed).toEqual(["- [x] Parent", "    - [x] Sub A", "    - [x] Sub B"]);
		expect(remaining(result)).toBe("- [ ] Open\n");
	});

	it("leaves the note untouched when nothing qualifies", () => {
		const note = ["- [ ] Open", "", "Text", ""].join("\n");
		const result = splitCompletedBlocks(note, strict);

		expect(result.completed).toEqual([]);
		expect(remaining(result)).toBe(note);
	});

	it("moves several blocks in document order", () => {
		const note = ["- [x] One", "- [ ] Two", "- [x] Three", ""].join("\n");
		const result = splitCompletedBlocks(note, strict);

		expect(result.completed).toEqual(["- [x] One", "- [x] Three"]);
		expect(remaining(result)).toBe("- [ ] Two\n");
	});

	it("does not move tasks that sit inside a code fence", () => {
		const note = ["```", "- [x] sample", "```", ""].join("\n");
		const result = splitCompletedBlocks(note, strict);

		expect(result.completed).toEqual([]);
		expect(remaining(result)).toBe(note);
	});

	it("empties a note that held nothing but a completed task", () => {
		const result = splitCompletedBlocks("- [x] Only\n", strict);
		expect(result.completed).toEqual(["- [x] Only"]);
		expect(remaining(result)).toBe("");
	});

	it("keeps CRLF endings when the source note is written back", () => {
		const note = "- [x] Done\r\n- [ ] Open\r\n";
		const result = splitCompletedBlocks(note, strict);

		expect(result.completed).toEqual(["- [x] Done"]);
		expect(remaining(result, "\r\n")).toBe("- [ ] Open\r\n");
	});
});

describe("findSection", () => {
	it("matches the heading text case-insensitively after trimming", () => {
		const { lines } = analyse("## ERLEDIGT\n- [x] a\n");
		expect(findSection(lines, "## erledigt")?.headingIndex).toBe(0);
		expect(findSection(lines, "  Erledigt  ")?.headingIndex).toBe(0);
	});

	it("does not match on a substring", () => {
		const { lines } = analyse("## Erledigt heute\n- [x] a\n");
		expect(findSection(lines, "Erledigt")).toBeNull();
	});

	it("ends at the next heading of any level", () => {
		const { lines } = analyse("## Erledigt\n- [x] a\n## Notes\n- [x] b\n");
		const section = findSection(lines, "Erledigt");

		expect(section).not.toBeNull();
		expect(section?.contentEnd).toBe(2);
	});

	it("ends at a thematic break", () => {
		const { lines } = analyse("## Erledigt\n- [x] a\n---\n- [x] b\n");
		expect(findSection(lines, "Erledigt")?.contentEnd).toBe(2);
	});

	it("runs to the end of the file when nothing follows", () => {
		const { lines } = analyse("# Title\n\n## Erledigt\n- [x] a\n");
		expect(findSection(lines, "Erledigt")?.contentEnd).toBe(lines.length);
	});
});

describe("sectionInsertIndex", () => {
	it("points at the last non-blank line of the section", () => {
		const { lines } = analyse("## Erledigt\n- [x] a\n\n\n");
		const section = findSection(lines, "Erledigt");
		if (section === null) throw new Error("section missing");

		expect(sectionInsertIndex(lines, section)).toBe(1);
	});

	it("points at the heading when the section is empty", () => {
		const { lines } = analyse("## Erledigt\n\n## Notes\n");
		const section = findSection(lines, "Erledigt");
		if (section === null) throw new Error("section missing");

		expect(sectionInsertIndex(lines, section)).toBe(0);
	});
});

describe("insertIntoSection", () => {
	it("appends at the end of an existing section", () => {
		const note = ["## Erledigt", "- [x] a", "", "## Notes", "- [ ] b", ""].join("\n");
		const result = insertIntoSection(note, ["- [x] new"], "## Erledigt", 2);

		expect(result).toBe(["## Erledigt", "- [x] a", "- [x] new", "", "## Notes", "- [ ] b", ""].join("\n"));
	});

	it("creates the heading at the end when it is missing", () => {
		const result = insertIntoSection("# 2026-10-16\n", ["- [x] new"], "## Erledigt", 2);

		expect(result).toBe(["# 2026-10-16", "", "## Erledigt", "", "- [x] new", ""].join("\n"));
	});

	it("honours the configured heading level", () => {
		const result = insertIntoSection("", ["- [x] new"], "Erledigt", 3);
		expect(result).toBe(["### Erledigt", "", "- [x] new", ""].join("\n"));
	});

	it("does not duplicate a heading that is already there", () => {
		const note = ["## Erledigt", "- [x] a", ""].join("\n");
		expect(insertIntoSection(note, ["- [x] new"], "## Erledigt", 2)).not.toContain("## Erledigt\n\n## Erledigt");
	});

	it("preserves CRLF endings", () => {
		const result = insertIntoSection("## Erledigt\r\n- [x] a\r\n", ["- [x] new"], "## Erledigt", 2);
		expect(result).toBe("## Erledigt\r\n- [x] a\r\n- [x] new\r\n");
	});

	it("returns the content unchanged when there is nothing to insert", () => {
		const note = "# Note\n";
		expect(insertIntoSection(note, [], "## Erledigt", 2)).toBe(note);
	});

	it("carries a parent and its sub-tasks into the section in one piece", () => {
		const note = ["# 2026-10-16", ""].join("\n");
		const entries = ["- [x] Parent", "    - [x] Sub A", "    - [x] Sub B"];
		expect(insertIntoSection(note, entries, "## Erledigt", 2)).toContain("- [x] Parent\n    - [x] Sub A\n    - [x] Sub B");
	});
});

describe("tidyContent", () => {
	it("drops trailing blank lines and ends with exactly one newline", () => {
		expect(tidyContent(["- [ ] a", "", "", ""], "\n")).toBe("- [ ] a\n");
	});

	it("returns an empty string for a note without content", () => {
		expect(tidyContent(["", ""], "\n")).toBe("");
	});
});