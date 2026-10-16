/**
 * Template rendering for newly created daily notes.
 *
 * This is the same substitution the Obsidian core daily-notes plugin performs,
 * mirrored here because this plugin creates the note itself. It was ported from
 * `obsidian-daily-notes-interface` (MIT, liamcain) so that a note created by
 * this plugin is indistinguishable from one created by the core plugin.
 *
 * Supported placeholders, all case-insensitive:
 *
 *     {{date}}                 the date the note is for, in the note's format
 *     {{title}}                same as {{date}}
 *     {{time}}                 the current time as HH:mm
 *     {{date+1d}} {{date-2w}}  the date shifted by the given amount
 *     {{date+1d:MMMM}}         shifted, in an explicit format
 *     {{yesterday}} {{tomorrow}}
 *
 * A `Moment` is passed in rather than importing one, so this module stays free
 * of both Obsidian and moment imports and can be unit-tested in plain Node.
 */

/** Moment's duration units, narrowed so `add`/`subtract` stay type-safe here. */
export type DateUnit = "year" | "y" | "month" | "M" | "week" | "w" | "day" | "d" | "hour" | "h" | "minute" | "m" | "second" | "s";

/** The subset of moment this module needs. */
export interface RenderableDate {
	format(pattern: string): string;
	clone(): RenderableDate;
	subtract(amount: number, unit: DateUnit): RenderableDate;
	add(amount: number, unit: DateUnit): RenderableDate;
	set(values: Record<string, number>): RenderableDate;
}

const PLACEHOLDER = /\{\{\s*(date|time|title)(([+-])\d+)?\s*([yqmwdhs]?)\s*(:.+?)?\}\}/gi;

/**
 * Returns the template with every supported placeholder replaced.
 *
 * Unknown placeholders are left untouched, which matters because templates
 * routinely contain Templater or Dataview syntax that Obsidian's own plugin
 * does not expand either.
 */
export function renderTemplate(raw: string, date: RenderableDate, noteFormat: string): string {
	const now = new Date();
	const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	const today = date.format(noteFormat);

	return raw
		.replace(PLACEHOLDER, (match, field: string, offset: string | undefined, sign: string | undefined, unit: string | undefined, formatArg: string | undefined) => {
			const name = String(field).toLowerCase();

			if (name === "time") return time;
			if (name === "title") return today;
			if (name !== "date") return match;

			// "{{date}}" with neither offset nor unit: the note's own date.
			if (!offset) return today;

			// "{{date+1d}}" and friends: the same clock time as now, shifted.
			const shifted = date
				.clone()
				.set({
					hour: now.getHours(),
					minute: now.getMinutes(),
					second: now.getSeconds(),
				});
			// The offset carries its own sign, so it is parsed as an absolute
			// value and the sign decides the direction. Parsing it directly would
			// make "{{date-2d}}" subtract twice, i.e. move two days forward.
			const amount = Math.abs(Number.parseInt(offset, 10));
			// "{{date+1}}" has no unit letter; the regex yields "" there, and a
			// bare number means one day.
			const durationUnit = (unit === undefined || unit.length === 0 ? "d" : unit) as DateUnit;
			const applied =
				sign === "-"
					? shifted.subtract(amount, durationUnit)
					: shifted.add(amount, durationUnit);

			// "{{date+1d:MMMM}}" — an explicit format overrides the note's format.
			return formatArg !== undefined && formatArg.length > 1
				? applied.format(formatArg.slice(1).trim())
				: applied.format(noteFormat);
		})
		.replace(/\{\{\s*yesterday\s*\}\}/gi, date.clone().subtract(1, "day").format(noteFormat))
		.replace(/\{\{\s*tomorrow\s*\}\}/gi, date.clone().add(1, "d").format(noteFormat));
}