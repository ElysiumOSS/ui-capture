/**
 *
 * Copyright 2026 Mike Odnis
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USAGE } from "./runner.js";
import { CaptureConfig, CaptureStep } from "./schemas.js";

/**
 * Documentation drift is the defect class that survives every other test: the
 * flag works, the schema is right, and only the README lies. These assertions
 * make `--help`, the README and the schema fail together.
 */
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("README ↔ USAGE", () => {
	it("reproduces the whole option and example list verbatim", () => {
		// The README drops only USAGE's leading description paragraph, since the
		// page already carries one; everything from `Arguments:` on must match.
		const body = USAGE.slice(USAGE.indexOf("Arguments:"));
		expect(README).toContain(body.trimEnd());
	});

	it("shows the scripted-state flags in both", () => {
		const flags = [
			"--states",
			"--state-filter",
			"--skip-routes",
			"--state-timeout",
			"--allow-state-requests",
			"--fail-on-state-error",
		];
		for (const flag of flags) {
			expect(USAGE, `USAGE is missing ${flag}`).toContain(flag);
			expect(README, `README is missing ${flag}`).toContain(flag);
		}
	});
});

describe("README ↔ schema", () => {
	it("documents every step kind in the vocabulary table", () => {
		const kinds = CaptureStep.members.map(
			(member) => member.fields.kind.literals[0],
		);
		expect(kinds.length).toBeGreaterThan(0);
		for (const kind of kinds) {
			expect(README, `README does not document the "${kind}" step`).toContain(
				`| \`${kind}\` |`,
			);
		}
	});

	it("documents every scripted-state config field with its default", () => {
		const rows: ReadonlyArray<readonly [string, string]> = [
			["states", "`[]`"],
			["stateTimeout", `\`${CaptureConfig.Default.stateTimeout}\``],
			["captureRoutes", `\`${CaptureConfig.Default.captureRoutes}\``],
			["allowStateRequests", `\`${CaptureConfig.Default.allowStateRequests}\``],
		];
		for (const [field, rendered] of rows) {
			const row = README.split("\n").find((line) =>
				line.startsWith(`| \`${field}\``),
			);
			expect(row, `README has no config row for ${field}`).toBeDefined();
			expect(row, `${field} row does not show ${rendered}`).toContain(rendered);
		}
	});
});
