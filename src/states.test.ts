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

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { StateDefinitionError } from "./errors.js";
import type { CaptureState } from "./schemas.js";
import {
	filterStates,
	MAX_STATE_CHAIN_DEPTH,
	parseStatesFile,
	resolveStateSteps,
	statesUseRequests,
	validateStates,
} from "./states.js";

const file = (states: unknown): string =>
	JSON.stringify({ version: 1, states });

const parse = (states: unknown): ReadonlyArray<CaptureState> =>
	parseStatesFile(file(states), "states.json");

const chain = (names: readonly string[]): ReadonlyArray<CaptureState> =>
	parse(
		names.map((name, index) => ({
			name,
			steps: [{ kind: "click", selector: `#${name}` }],
			...(index === 0 ? {} : { extends: names[index - 1] }),
		})),
	);

const allowAllHosts = () => true;

const runValidate = (
	overrides: Partial<Parameters<typeof validateStates>[0]>,
) =>
	Effect.runSyncExit(
		validateStates({
			states: [],
			seedUrl: "https://app.example.com/",
			hostMatchesFilters: allowAllHosts,
			allowStateRequests: false,
			viewportNames: ["desktop", "mobile"],
			captureRoutes: true,
			...overrides,
		}),
	);

const failureMessage = (
	exit: Exit.Exit<unknown, StateDefinitionError>,
): string => {
	if (Exit.isSuccess(exit)) throw new Error("expected a definition failure");
	const error = Exit.causeOption(exit);
	return JSON.stringify(error);
};

describe("parseStatesFile", () => {
	it("decodes a well-formed file and applies step defaults", () => {
		const states = parse([
			{
				name: "spawn-dialog",
				steps: [
					{ kind: "waitFor", selector: "canvas[data-scene-ready]" },
					{ kind: "click", selector: "[data-testid='spawn-drone']" },
				],
			},
		]);
		expect(states).toHaveLength(1);
		expect(states[0]?.name).toBe("spawn-dialog");
		expect(states[0]?.steps[0]).toMatchObject({
			kind: "waitFor",
			state: "visible",
			optional: false,
		});
		expect(states[0]?.allowVideoReplay).toBe(false);
	});

	it("requires the version discriminant rather than defaulting it", () => {
		expect(() =>
			parseStatesFile(JSON.stringify({ states: [] }), "states.json"),
		).toThrow(/version/);
	});

	it("names the offending path when a step kind is unknown", () => {
		expect(() =>
			parse([{ name: "x", steps: [{ kind: "evaluate", js: "alert(1)" }] }]),
		).toThrow(/states\.0\.steps\.0/);
	});

	it("rejects a state name that would not survive as a directory", () => {
		expect(() => parse([{ name: "Spawn Dialog", steps: [] }])).toThrow(
			/states\.0\.name/,
		);
	});

	it("reports unparseable JSON against the source path", () => {
		expect(() => parseStatesFile("{not json", "states.json")).toThrow(
			/states\.json is not valid JSON/,
		);
	});
});

describe("statesUseRequests", () => {
	it("is true only when a request step is present", () => {
		expect(statesUseRequests(parse([{ name: "a", steps: [] }]))).toBe(false);
		expect(
			statesUseRequests(
				parse([
					{
						name: "a",
						steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
					},
				]),
			),
		).toBe(true);
	});
});

describe("resolveStateSteps", () => {
	it("prepends the parent's steps and inherits its url", () => {
		const states = parse([
			{
				name: "fleet",
				url: "/console",
				steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
			},
			{
				name: "fleet-editor",
				extends: "fleet",
				steps: [{ kind: "click", selector: "[data-panel='editor']" }],
			},
		]);
		const resolved = resolveStateSteps(states);
		const child = resolved.get("fleet-editor");
		expect(child?.steps.map((step) => step.kind)).toEqual(["request", "click"]);
		expect(child?.url).toBe("/console");
	});

	it("lets a child override the inherited url", () => {
		const resolved = resolveStateSteps(
			parse([
				{ name: "base", url: "/a", steps: [] },
				{ name: "child", extends: "base", url: "/b", steps: [] },
			]),
		);
		expect(resolved.get("child")?.url).toBe("/b");
	});

	it("rejects duplicate names, because names become directories", () => {
		expect(() =>
			resolveStateSteps(
				parse([
					{ name: "dup", steps: [] },
					{ name: "dup", steps: [] },
				]),
			),
		).toThrow(StateDefinitionError);
	});

	it("rejects an unknown parent", () => {
		expect(() =>
			resolveStateSteps(parse([{ name: "a", extends: "nope", steps: [] }])),
		).toThrow(/extends unknown state/);
	});

	it("rejects a cycle", () => {
		expect(() =>
			resolveStateSteps(
				parse([
					{ name: "a", extends: "b", steps: [] },
					{ name: "b", extends: "a", steps: [] },
				]),
			),
		).toThrow(/extends cycle/);
	});

	it("allows a chain at the depth limit and rejects one past it", () => {
		const names = Array.from(
			{ length: MAX_STATE_CHAIN_DEPTH + 1 },
			(_, index) => `s${index}`,
		);
		expect(() => resolveStateSteps(chain(names))).not.toThrow();
		expect(() => resolveStateSteps(chain([...names, "over"]))).toThrow(
			/links deep/,
		);
	});
});

describe("validateStates", () => {
	it("succeeds trivially when there are no states", () => {
		expect(Exit.isSuccess(runValidate({}))).toBe(true);
	});

	it("refuses a run that would capture nothing", () => {
		expect(Exit.isSuccess(runValidate({ captureRoutes: false }))).toBe(false);
	});

	it("rejects a state URL outside the allowed hosts", () => {
		const exit = runValidate({
			states: parse([{ name: "off", url: "https://evil.test/x", steps: [] }]),
			hostMatchesFilters: (hostname) => hostname === "app.example.com",
		});
		expect(Exit.isSuccess(exit)).toBe(false);
		expect(failureMessage(exit)).toContain("outside the allowed hosts");
	});

	it("rejects a viewport filter naming a viewport that is not configured", () => {
		const exit = runValidate({
			states: parse([{ name: "v", viewports: ["ultrawide"], steps: [] }]),
		});
		expect(Exit.isSuccess(exit)).toBe(false);
		expect(failureMessage(exit)).toContain("ultrawide");
	});

	it("accepts a viewport filter naming a configured viewport", () => {
		expect(
			Exit.isSuccess(
				runValidate({
					states: parse([{ name: "v", viewports: ["desktop"], steps: [] }]),
				}),
			),
		).toBe(true);
	});

	it("blocks request steps unless they are explicitly allowed", () => {
		const states = parse([
			{
				name: "seed",
				steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
			},
		]);
		expect(Exit.isSuccess(runValidate({ states }))).toBe(false);
		expect(
			Exit.isSuccess(runValidate({ states, allowStateRequests: true })),
		).toBe(true);
	});

	it("blocks an off-host request even when request steps are allowed", () => {
		const exit = runValidate({
			states: parse([
				{
					name: "seed",
					steps: [
						{
							kind: "request",
							method: "POST",
							path: "https://evil.test/collect",
						},
					],
				},
			]),
			allowStateRequests: true,
			hostMatchesFilters: (hostname) => hostname === "app.example.com",
		});
		expect(Exit.isSuccess(exit)).toBe(false);
		expect(failureMessage(exit)).toContain("outside the allowed hosts");
	});

	it("checks a request inherited through extends, not just a state's own steps", () => {
		const states = parse([
			{
				name: "seed",
				steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
			},
			{ name: "child", extends: "seed", steps: [] },
		]);
		expect(Exit.isSuccess(runValidate({ states }))).toBe(false);
	});
});

describe("filterStates", () => {
	it("keeps ancestors so a filtered run still resolves", () => {
		const states = parse([
			{ name: "base", steps: [] },
			{ name: "middle", extends: "base", steps: [] },
			{ name: "leaf", extends: "middle", steps: [] },
			{ name: "unrelated", steps: [] },
		]);
		expect(filterStates(states, ["leaf"]).map((state) => state.name)).toEqual([
			"base",
			"middle",
			"leaf",
		]);
	});

	it("throws on a name that matches nothing", () => {
		expect(() =>
			filterStates(parse([{ name: "a", steps: [] }]), ["b"]),
		).toThrow(/Unknown state name/);
	});
});

describe("parseStatesFile — rejected shapes", () => {
	/**
	 * The step vocabulary becomes a public JSON format on other people's disks
	 * the day it ships, so every rejection has to name the path that is wrong.
	 * Each case asserts the message points at the offending field, not just
	 * that a throw happened.
	 */
	const rejects = (states: unknown, pattern: RegExp) => {
		expect(() => parse(states)).toThrow(pattern);
	};

	it("rejects a version it does not understand", () => {
		expect(() =>
			parseStatesFile(
				JSON.stringify({ version: 2, states: [] }),
				"states.json",
			),
		).toThrow(/version/);
	});

	it("rejects a file with no states array", () => {
		expect(() =>
			parseStatesFile(JSON.stringify({ version: 1 }), "states.json"),
		).toThrow(/states/);
	});

	it("rejects a state with no steps", () => {
		rejects([{ name: "a" }], /states\.0\.steps/);
	});

	it("rejects a state name that is empty, uppercase, or oddly punctuated", () => {
		for (const name of [
			"",
			"Spawn",
			"spawn dialog",
			"-spawn",
			"spawn_dialog",
		]) {
			rejects([{ name, steps: [] }], /states\.0\.name/);
		}
	});

	it("accepts the names that survive as directories", () => {
		expect(
			parse([
				{ name: "spawn-dialog", steps: [] },
				{ name: "fleet2", steps: [] },
				{ name: "0", steps: [] },
			]),
		).toHaveLength(3);
	});

	it("rejects a click with no selector", () => {
		rejects([{ name: "a", steps: [{ kind: "click" }] }], /steps\.0/);
	});

	it("rejects a press with no key", () => {
		rejects([{ name: "a", steps: [{ kind: "press" }] }], /steps\.0/);
	});

	it("rejects a select with no values", () => {
		rejects(
			[{ name: "a", steps: [{ kind: "select", selector: "#s" }] }],
			/steps\.0/,
		);
	});

	it("rejects a negative wait", () => {
		rejects([{ name: "a", steps: [{ kind: "wait", ms: -1 }] }], /steps\.0/);
	});

	it("rejects minCount of zero, which would assert nothing", () => {
		rejects(
			[
				{
					name: "a",
					steps: [{ kind: "waitFor", selector: "#x", minCount: 0 }],
				},
			],
			/steps\.0/,
		);
	});

	it("rejects a non-positive timeout or a negative settle", () => {
		rejects(
			[{ name: "a", steps: [{ kind: "click", selector: "#x", timeoutMs: 0 }] }],
			/steps\.0/,
		);
		rejects(
			[
				{
					name: "a",
					steps: [{ kind: "click", selector: "#x", settleMs: -5 }],
				},
			],
			/steps\.0/,
		);
	});

	it("rejects an HTTP method outside the closed union", () => {
		rejects(
			[
				{
					name: "a",
					steps: [{ kind: "request", method: "TRACE", path: "/x" }],
				},
			],
			/steps\.0/,
		);
	});

	it("rejects non-string header values", () => {
		rejects(
			[
				{
					name: "a",
					steps: [
						{
							kind: "request",
							method: "GET",
							path: "/x",
							headers: { "x-n": 1 },
						},
					],
				},
			],
			/steps\.0/,
		);
	});

	it("rejects a waitUntil Playwright would not accept", () => {
		rejects(
			[{ name: "a", steps: [{ kind: "reload", waitUntil: "idle" }] }],
			/steps\.0/,
		);
	});

	it("rejects a waitFor DOM state outside the closed union", () => {
		rejects(
			[
				{
					name: "a",
					steps: [{ kind: "waitFor", selector: "#x", state: "painted" }],
				},
			],
			/steps\.0/,
		);
	});

	it("rejects a whole-state timeout of zero", () => {
		rejects([{ name: "a", steps: [], timeoutMs: 0 }], /states\.0\.timeoutMs/);
	});

	it("names the second state when the second state is the broken one", () => {
		rejects(
			[
				{ name: "good", steps: [] },
				{ name: "bad", steps: [{ kind: "nope" }] },
			],
			/states\.1\.steps\.0/,
		);
	});
});

describe("parseStatesFile — accepted shapes", () => {
	it("accepts every step kind in the vocabulary", () => {
		const states = parse([
			{
				name: "everything",
				description: "one of each",
				url: "/console?mode=advanced",
				precondition: "[data-advanced]",
				viewports: ["desktop"],
				timeoutMs: 45000,
				allowVideoReplay: true,
				steps: [
					{ kind: "waitFor", selector: "#a", state: "hidden", minCount: 2 },
					{ kind: "wait", ms: 0 },
					{ kind: "click", selector: "#b", nth: 0, optional: true },
					{ kind: "fill", selector: "#c", value: "v" },
					{ kind: "select", selector: "#d", values: ["x", "y"] },
					{ kind: "press", key: "w", selector: "#e" },
					{
						kind: "request",
						method: "DELETE",
						path: "/api/x",
						json: null,
						headers: { a: "b" },
						expectStatus: 204,
					},
					{ kind: "reload", waitUntil: "commit", settleMs: 250 },
				],
			},
		]);
		expect(states[0]?.steps.map((step) => step.kind)).toEqual([
			"waitFor",
			"wait",
			"click",
			"fill",
			"select",
			"press",
			"request",
			"reload",
		]);
		expect(states[0]?.allowVideoReplay).toBe(true);
		expect(states[0]?.precondition).toBe("[data-advanced]");
		expect(states[0]?.viewports).toEqual(["desktop"]);
	});

	it("has no step kind that carries arbitrary code", () => {
		// The non-negotiable: no `evaluate`, `script`, `js` or `fn` step exists,
		// and no value in the grammar is ever interpreted as code.
		for (const kind of ["evaluate", "script", "js", "fn", "exec"]) {
			expect(() => parse([{ name: "a", steps: [{ kind }] }])).toThrow();
		}
	});
});
