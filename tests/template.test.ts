import { renderTemplate, type DateUnit, type RenderableDate } from "../src/template";

/**
 * Minimal stand-in for moment, implementing exactly the surface
 * `renderTemplate` declares. Using the real moment here would drag its locale
 * and timezone handling into the test, which is not what these cases test.
 */
class FakeDate implements RenderableDate {
	constructor(
		private year: number,
		private month: number,
		private day: number,
		private hour = 0,
		private minute = 0,
		private second = 0,
	) {}

	clone(): FakeDate {
		return new FakeDate(this.year, this.month, this.day, this.hour, this.minute, this.second);
	}

	set(values: Record<string, number>): FakeDate {
		if (values.hour !== undefined) this.hour = values.hour;
		if (values.minute !== undefined) this.minute = values.minute;
		if (values.second !== undefined) this.second = values.second;
		return this;
	}

	private shift(amount: number, unit: DateUnit): FakeDate {
		const next = this.clone();
		if (unit === "day" || unit === "d") next.day += amount;
		else if (unit === "week" || unit === "w") next.day += amount * 7;
		else if (unit === "month" || unit === "M") next.month += amount;
		else if (unit === "year" || unit === "y") next.year += amount;
		else if (unit === "hour" || unit === "h") next.hour += amount;
		else if (unit === "minute" || unit === "m") next.minute += amount;
		else if (unit === "second" || unit === "s") next.second += amount;
		return next;
	}

	subtract(amount: number, unit: DateUnit): FakeDate {
		return this.shift(-amount, unit);
	}

	add(amount: number, unit: DateUnit): FakeDate {
		return this.shift(amount, unit);
	}

	format(pattern: string): string {
		const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
		switch (pattern) {
			case "YYYY-MM-DD":
				return `${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`;
			case "YYYY":
				return pad(this.year, 4);
			case "MMMM":
				return ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"][this.month - 1];
			case "HH:mm":
				return `${pad(this.hour)}:${pad(this.minute)}`;
			case "YYYY/MM/YYYY-MM-DD":
				return `${pad(this.year, 4)}/${pad(this.month)}/${pad(this.year, 4)}-${pad(this.month)}-${pad(this.day)}`;
			default:
				return pattern;
		}
	}
}

const OCT_16 = new FakeDate(2026, 10, 16);
const FORMAT = "YYYY-MM-DD";

describe("renderTemplate", () => {
	it("ersetzt {{date}} mit dem Notizdatum im Notizformat", () => {
		expect(renderTemplate("# {{date}}", OCT_16, FORMAT)).toBe("# 2026-10-16");
	});

	it("ersetzt {{title}} genauso wie {{date}}", () => {
		expect(renderTemplate("{{title}}", OCT_16, FORMAT)).toBe("2026-10-16");
	});

	it("beachtet Gross- und Kleinschreibung nicht", () => {
		expect(renderTemplate("{{DATE}} {{Date}}", OCT_16, FORMAT)).toBe("2026-10-16 2026-10-16");
	});

	it("toleriert Leerzeichen im Platzhalter", () => {
		expect(renderTemplate("{{  date  }}", OCT_16, FORMAT)).toBe("2026-10-16");
	});

	it("verschiebt mit {{date+1d}} nach vorn", () => {
		expect(renderTemplate("{{date+1d}}", OCT_16, FORMAT)).toBe("2026-10-17");
	});

	it("verschiebt mit {{date-2d}} nach hinten", () => {
		expect(renderTemplate("{{date-2d}}", OCT_16, FORMAT)).toBe("2026-10-14");
	});

	it("verschiebt mit {{date+1w}} um eine Woche", () => {
		expect(renderTemplate("{{date+1w}}", OCT_16, FORMAT)).toBe("2026-10-23");
	});

	it("behandelt eine fehlende Einheit als einen Tag", () => {
		expect(renderTemplate("{{date+1}}", OCT_16, FORMAT)).toBe("2026-10-17");
	});

	it("nutzt bei {{date+1d:MMMM}} das uebergebene Format statt des Notizformats", () => {
		// The offset is +1 day, so the 16th stays inside October; what matters is
		// that MMMM is used instead of the note's YYYY-MM-DD.
		expect(renderTemplate("{{date+1d:MMMM}}", OCT_16, FORMAT)).toBe("Oktober");
	});

	it("nutzt bei {{date+1M:MMMM}} den Monatsversatz", () => {
		expect(renderTemplate("{{date+1M:MMMM}}", OCT_16, FORMAT)).toBe("November");
	});

	it("ersetzt {{yesterday}} und {{tomorrow}}", () => {
		expect(renderTemplate("{{yesterday}} {{tomorrow}}", OCT_16, FORMAT)).toBe("2026-10-15 2026-10-17");
	});

	it("ersetzt {{time}} mit HH:mm", () => {
		expect(renderTemplate("{{time}}", OCT_16, FORMAT)).toMatch(/^\d{2}:\d{2}$/);
	});

	it("laesst unbekannte Platzhalter unangetastet", () => {
		expect(renderTemplate("{{tp.date}} <% tp.file.title %>", OCT_16, FORMAT)).toBe(
			"{{tp.date}} <% tp.file.title %>",
		);
	});

	it("ersetzt Task-Zeilen im Template nicht", () => {
		const template = "- [ ] Kimai\n- [ ] Salesforce\n";
		expect(renderTemplate(template, OCT_16, FORMAT)).toBe(template);
	});

	it("verarbeitet ein realistisches Template vollstaendig", () => {
		const template = ["# {{date}}", "", "- [ ] Kimai", "", "Gestern: {{yesterday}}", ""].join("\n");
		expect(renderTemplate(template, OCT_16, FORMAT)).toBe(
			["# 2026-10-16", "", "- [ ] Kimai", "", "Gestern: 2026-10-15", ""].join("\n"),
		);
	});

	it("aendert die Originalvorlage nicht", () => {
		const template = "# {{date}}";
		renderTemplate(template, OCT_16, FORMAT);
		expect(template).toBe("# {{date}}");
	});
});