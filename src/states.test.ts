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

	it("inherits allowVideoReplay alongside the steps that make it matter", () => {
		// The child inherits the parent's `request` step, which is what
		// suppresses video. Inheriting the step without its opt-out leaves the
		// child unable to undo a decision it never made.
		const resolved = resolveStateSteps(
			parse([
				{
					name: "seeded",
					allowVideoReplay: true,
					steps: [{ kind: "request", method: "PUT", path: "/api/seed" }],
				},
				{
					name: "seeded-editor",
					extends: "seeded",
					steps: [{ kind: "click", selector: "#edit" }],
				},
			]),
		);
		expect(resolved.get("seeded")?.allowVideoReplay).toBe(true);
		expect(resolved.get("seeded-editor")?.allowVideoReplay).toBe(true);
	});

	it("leaves allowVideoReplay false when no state in the chain sets it", () => {
		const resolved = resolveStateSteps(
			parse([
				{ name: "base", steps: [] },
				{ name: "child", extends: "base", steps: [] },
			]),
		);
		expect(resolved.get("child")?.allowVideoReplay).toBe(false);
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
		expect(failureMessage(exit)).toContain("outside the allowed origins");
	});

	it("rejects an allowed host on a different port, because that is a different origin", () => {
		const exit = runValidate({
			states: parse([
				{
					name: "other-port",
					url: "https://app.example.com:8443/x",
					steps: [],
				},
			]),
			hostMatchesFilters: (hostname) => hostname === "app.example.com",
		});
		expect(Exit.isSuccess(exit)).toBe(false);
		expect(failureMessage(exit)).toContain("scheme + host + port");
	});

	it("rejects an allowed host on a downgraded scheme", () => {
		const exit = runValidate({
			states: parse([
				{ name: "plain", url: "http://app.example.com/x", steps: [] },
			]),
			hostMatchesFilters: (hostname) => hostname === "app.example.com",
		});
		expect(Exit.isSuccess(exit)).toBe(false);
		expect(failureMessage(exit)).toContain("outside the allowed origins");
	});

	it("accepts the seed's own port written explicitly", () => {
		const exit = runValidate({
			seedUrl: "http://localhost:5173/",
			states: parse([
				{ name: "same", url: "http://localhost:5173/console", steps: [] },
			]),
			hostMatchesFilters: (hostname) => hostname === "localhost",
		});
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("accepts a default port written explicitly, since URL normalises it away", () => {
		const exit = runValidate({
			states: parse([
				{ name: "explicit", url: "https://app.example.com:443/x", steps: [] },
			]),
			hostMatchesFilters: (hostname) => hostname === "app.example.com",
		});
		expect(Exit.isSuccess(exit)).toBe(true);
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
		expect(failureMessage(exit)).toContain("outside the allowed origins");
	});

	it("blocks a request that resolves to the allowed host on another port", () => {
		const exit = runValidate({
			states: parse([
				{
					name: "seed",
					steps: [
						{
							kind: "request",
							method: "POST",
							path: "https://app.example.com:9000/api/seed",
						},
					],
				},
			]),
			allowStateRequests: true,
			hostMatchesFilters: (hostname) => hostname === "app.example.com",
		});
		expect(Exit.isSuccess(exit)).toBe(false);
		expect(failureMessage(exit)).toContain("outside the allowed origins");
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
	/**
	 * The previous assertion here was that the ancestors came back in the list
	 * ("keeps ancestors so a filtered run still resolves"). That was the bug:
	 * `--state-filter leaf` then captured `base` and `middle` as well, and re-ran
	 * their steps. Resolution needs the ancestors; capture must not see them.
	 */
	const chainStates = () =>
		parse([
			{
				name: "base",
				url: "/console",
				steps: [{ kind: "click", selector: "#b" }],
			},
			{
				name: "middle",
				extends: "base",
				steps: [{ kind: "click", selector: "#m" }],
			},
			{
				name: "leaf",
				extends: "middle",
				steps: [{ kind: "click", selector: "#l" }],
			},
			{ name: "unrelated", steps: [] },
		]);

	it("returns only the named states, never the ancestors they resolve through", () => {
		expect(
			filterStates(chainStates(), ["leaf"]).map((state) => state.name),
		).toEqual(["leaf"]);
	});

	it("folds the ancestors' steps and inherited url into the named state", () => {
		const [leaf] = filterStates(chainStates(), ["leaf"]);
		expect(leaf?.steps.map((step) => step.selector)).toEqual([
			"#b",
			"#m",
			"#l",
		]);
		expect(leaf?.url).toBe("/console");
		expect(leaf?.extends).toBeUndefined();
	});

	it("keeps the child's own url rather than the inherited one", () => {
		const states = parse([
			{ name: "base", url: "/a", steps: [] },
			{ name: "child", extends: "base", url: "/b", steps: [] },
		]);
		expect(filterStates(states, ["child"])[0]?.url).toBe("/b");
	});

	it("carries the child's other fields through the flattening", () => {
		const states = parse([
			{ name: "base", steps: [] },
			{
				name: "child",
				extends: "base",
				description: "d",
				precondition: "[data-x]",
				viewports: ["desktop"],
				timeoutMs: 1234,
				allowVideoReplay: true,
				steps: [],
			},
		]);
		expect(filterStates(states, ["child"])[0]).toMatchObject({
			description: "d",
			precondition: "[data-x]",
			viewports: ["desktop"],
			timeoutMs: 1234,
			allowVideoReplay: true,
		});
	});

	it("carries the inherited allowVideoReplay, not just the child's own", () => {
		// The flag and the `request` step that makes it matter travel together:
		// the child inherits the seed step, so it has to inherit the opt-out
		// too, or the same states file records video unfiltered and silently
		// drops it under --state-filter.
		const states = parse([
			{
				name: "seed",
				allowVideoReplay: true,
				steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
			},
			{ name: "child", extends: "seed", steps: [] },
		]);
		const [child] = filterStates(states, ["child"]);
		expect(child?.steps.some((step) => step.kind === "request")).toBe(true);
		expect(child?.allowVideoReplay).toBe(true);
	});

	it("does not re-run an ancestor's request seed as a state of its own", () => {
		const states = parse([
			{
				name: "seed",
				steps: [{ kind: "request", method: "POST", path: "/api/seed" }],
			},
			{ name: "child", extends: "seed", steps: [] },
		]);
		const selected = filterStates(states, ["child"]);
		expect(selected.map((state) => state.name)).toEqual(["child"]);
		expect(
			selected.flatMap((state) =>
				state.steps.filter((step) => step.kind === "request"),
			),
		).toHaveLength(1);
	});

	it("still returns an ancestor when the ancestor is what was named", () => {
		expect(
			filterStates(chainStates(), ["base"]).map((state) => state.name),
		).toEqual(["base"]);
	});

	it("returns file order and deduplicates a repeated name", () => {
		expect(
			filterStates(chainStates(), ["unrelated", "base", "base"]).map(
				(state) => state.name,
			),
		).toEqual(["base", "unrelated"]);
	});

	it("propagates a broken chain, since a filtered run still has to resolve", () => {
		const states = parse([
			{ name: "a", extends: "b", steps: [] },
			{ name: "b", extends: "a", steps: [] },
		]);
		expect(() => filterStates(states, ["a"])).toThrow(/extends cycle/);
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

	it("rejects an empty viewports list, which would capture nothing", () => {
		// A state with `viewports: []` used to decode, pass validation vacuously
		// and be reported as captured with zero screenshots.
		rejects([{ name: "a", steps: [], viewports: [] }], /states\.0\.viewports/);
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

describe("validateStates — inexpressible step shapes", () => {
	// These abort the run rather than failing one state at a time. A shape that
	// contradicts itself cannot start working on a retry, and finding out per
	// state per viewport is four identical failures instead of one fixable
	// message. `planStep` rejects them again at runtime, so a programmatic
	// caller cannot route around this pass.
	it("rejects minCount on a state that also passes when nothing matches", () => {
		for (const state of ["hidden", "detached"]) {
			const states = parse([
				{
					name: "fleet",
					steps: [
						{ kind: "waitFor", selector: ".fleet-row", state, minCount: 6 },
					],
				},
			]);
			const message = failureMessage(runValidate({ states }));
			expect(message).toContain("step 0");
			expect(message).toContain("minCount counts matching elements");
			expect(message).toContain(state);
		}
	});

	it("accepts minCount with visible and attached", () => {
		for (const state of ["visible", "attached"]) {
			const states = parse([
				{
					name: "fleet",
					steps: [
						{ kind: "waitFor", selector: ".fleet-row", state, minCount: 6 },
					],
				},
			]);
			expect(Exit.isSuccess(runValidate({ states }))).toBe(true);
		}
	});

	it("rejects a timeoutMs on a press with no element to wait for", () => {
		const states = parse([
			{
				name: "esc",
				steps: [{ kind: "press", key: "Escape", timeoutMs: 9000 }],
			},
		]);
		const message = failureMessage(runValidate({ states }));
		expect(message).toContain("timeoutMs has no effect on an untargeted press");
	});

	it("leaves a targeted press with a timeoutMs alone", () => {
		const states = parse([
			{
				name: "submit",
				steps: [
					{ kind: "press", key: "Enter", selector: "#form", timeoutMs: 9000 },
				],
			},
		]);
		expect(Exit.isSuccess(runValidate({ states }))).toBe(true);
	});

	it("checks inherited steps too, and names the index in the flattened script", () => {
		const states = parse([
			{ name: "base", steps: [{ kind: "click", selector: "#open" }] },
			{
				name: "child",
				extends: "base",
				steps: [{ kind: "press", key: "Escape", timeoutMs: 10 }],
			},
		]);
		expect(failureMessage(runValidate({ states }))).toContain("step 1");
	});
});
