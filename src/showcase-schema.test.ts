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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import { describe, expect, it } from "vitest";
import { type CaptureConfigOverrides, createCaptureConfig } from "./schemas.js";
import {
	createShowcaseOriginGate,
	parseShowcaseFile,
	validateShowcase,
} from "./showcase-schema.js";

const file = (overrides: Record<string, unknown> = {}) => ({
	version: 1,
	name: "portfolio-tour",
	scenes: [{ name: "intro", steps: [] }],
	...overrides,
});
const parse = (value: unknown = file()) =>
	parseShowcaseFile(JSON.stringify(value), "tour.json");
const config = (overrides: CaptureConfigOverrides = {}) =>
	createCaptureConfig({
		viewports: [{ name: "desktop", width: 1920, height: 1080 }],
		...overrides,
	});
const validate = (
	value: unknown = file(),
	overrides: CaptureConfigOverrides = {},
	seed = "https://app.example.com/",
) => validateShowcase(parse(value), seed, config(overrides));
const withSteps = (steps: unknown[]) =>
	file({ scenes: [{ name: "intro", steps }] });

describe("parseShowcaseFile", () => {
	it("decodes the continuous tour and presentation defaults", () => {
		const result = parse(
			file({
				scenes: [
					{
						name: "intro",
						steps: [{ kind: "type", selector: "#search", value: "rescue" }],
					},
					{
						name: "results",
						steps: [
							{ kind: "hover", selector: "#result" },
							{ kind: "scroll", y: 500 },
						],
					},
				],
			}),
		);
		expect(result).toMatchObject({
			version: 1,
			cursor: true,
			captions: true,
			timeoutMs: 300000,
		});
		expect(result.scenes[0]).toMatchObject({ timeoutMs: 60000, holdMs: 2000 });
		expect(result.scenes[0]?.steps[0]).toMatchObject({
			optional: false,
			delayMs: 80,
			clear: true,
		});
		expect(result.scenes[1]?.steps).toMatchObject([
			{ kind: "hover", nth: 0, optional: false },
			{ kind: "scroll", x: 0, y: 500, durationMs: 800, optional: false },
		]);
		expect(result.scenes[1]?.url).toBeUndefined();
	});

	it("retains the existing declarative step vocabulary and defaults", () => {
		const result = parse(
			withSteps([
				{ kind: "waitFor", selector: "#ready" },
				{ kind: "wait", ms: 0 },
				{ kind: "click", selector: "#open" },
				{ kind: "fill", selector: "#value", value: "" },
				{ kind: "select", selector: "select", values: ["x"] },
				{ kind: "press", key: "Escape" },
				{ kind: "request", method: "GET", path: "/status" },
				{ kind: "reload" },
			]),
		);
		expect(result.scenes[0]?.steps).toHaveLength(8);
		expect(result.scenes[0]?.steps[0]).toMatchObject({
			state: "visible",
			optional: false,
		});
		expect(result.scenes[0]?.steps[7]).toMatchObject({
			waitUntil: "networkidle",
		});
	});

	it("names malformed JSON and schema paths", () => {
		expect(() => parseShowcaseFile("{", "broken.json")).toThrow(
			/broken.json.*JSON/,
		);
		expect(() =>
			parse(withSteps([{ kind: "type", value: "missing selector" }])),
		).toThrow(/scenes.0.steps.0/);
	});

	it.each([
		file({ version: 2 }),
		file({ version: undefined }),
		file({ name: "../tour" }),
		file({ name: "Uppercase" }),
		file({ name: "a".repeat(65) }),
		file({ typo: true }),
		file({ scenes: [{ name: "intro", steps: [], evaluate: "evil()" }] }),
		withSteps([{ kind: "click", selector: "#open", javascript: "evil()" }]),
		withSteps([{ kind: "evaluate", source: "evil()" }]),
		file({ scenes: [] }),
		file({
			scenes: Array.from({ length: 101 }, (_, i) => ({
				name: `scene-${i}`,
				steps: [],
			})),
		}),
		withSteps(Array.from({ length: 201 }, () => ({ kind: "wait", ms: 0 }))),
	])("rejects invalid names, versions, structure and unknown fields (case %#)", (value) => {
		expect(() => parse(value)).toThrow(/Invalid showcase/);
	});

	it.each([
		{ kind: "type", selector: "#s", value: "x", delayMs: -1 },
		{ kind: "type", selector: "#s", value: "x", delayMs: 1001 },
		{ kind: "type", selector: "#s", value: "x", timeoutMs: 0 },
		{ kind: "type", selector: "#s", value: "x".repeat(10001) },
		{ kind: "hover", selector: "#s", nth: -1 },
		{ kind: "hover", selector: "#s", nth: 100001 },
		{ kind: "hover", selector: "#".repeat(2001) },
		{ kind: "scroll", y: -1 },
		{ kind: "scroll", y: 1000001 },
		{ kind: "scroll", y: 1, durationMs: 10001 },
		{ kind: "scroll", y: 1.5 },
	])("rejects out-of-range presentation steps (case %#)", (step) => {
		expect(() => parse(withSteps([step]))).toThrow();
	});

	it.each([
		file({ timeoutMs: 0 }),
		file({ timeoutMs: 900001 }),
		file({ scenes: [{ name: "intro", steps: [], timeoutMs: 300001 }] }),
		file({ scenes: [{ name: "intro", steps: [], holdMs: 60001 }] }),
	])("bounds scene and whole-tour time budgets (case %#)", (value) => {
		expect(() => parse(value)).toThrow();
	});
});

describe("validateShowcase", () => {
	it("accepts continuous scenes and relative navigation under the seed", () => {
		expect(() =>
			validate(
				file({
					scenes: [
						{ name: "intro", url: "/projects/", steps: [] },
						{
							name: "results",
							steps: [{ kind: "request", method: "GET", path: "status" }],
						},
					],
				}),
				{ allowStateRequests: true },
			),
		).not.toThrow();
	});

	it("rejects duplicate scene names and more than 1000 steps across scenes", () => {
		expect(() =>
			validate(
				file({
					scenes: [
						{ name: "intro", steps: [] },
						{ name: "intro", steps: [] },
					],
				}),
			),
		).toThrow(/duplicate.*intro/i);
		expect(() =>
			validate(
				file({
					scenes: Array.from({ length: 6 }, (_, i) => ({
						name: `scene-${i}`,
						steps: Array.from({ length: 200 }, () => ({ kind: "wait", ms: 0 })),
					})),
				}),
			),
		).toThrow(/1000/);
	});

	it.each([
		{ kind: "wait", ms: 60001 },
		{ kind: "click", selector: "#s", timeoutMs: 60001 },
		{ kind: "click", selector: "#s", settleMs: 60001 },
		{ kind: "click", selector: "#s", nth: 100001 },
		{ kind: "click", selector: "x".repeat(2001) },
		{ kind: "fill", selector: "#s", value: "x".repeat(10001) },
		{ kind: "waitFor", selector: "#s", minCount: 100001 },
		{ kind: "request", method: "GET", path: "/", expectStatus: 600 },
		{ kind: "request", method: "GET", path: "/", expectStatus: 99 },
		{ kind: "waitFor", selector: "#s", state: "hidden", minCount: 2 },
		{ kind: "press", key: "Escape", timeoutMs: 1000 },
	])("bounds and checks inherited step fields (case %#)", (step) => {
		expect(() =>
			validate(withSteps([step]), { allowStateRequests: true }),
		).toThrow(/intro.*step 0/);
	});

	it.each([
		"file:///tmp/site.html",
		"javascript:alert(1)",
		"https://user:secret@app.example.com/",
		"not-a-url",
	])("rejects unsupported or credentialed seed URLs: %s", (seed) => {
		expect(() => validate(file(), {}, seed)).toThrow(/seed/i);
	});

	it.each([
		"file:///tmp/site.html",
		"javascript:alert(1)",
		"https://user:secret@app.example.com/",
		"https://elsewhere.example/",
		"http://app.example.com/",
		"https://app.example.com:444/",
	])("rejects disallowed scene URLs: %s", (url) => {
		expect(() =>
			validate(file({ scenes: [{ name: "intro", url, steps: [] }] })),
		).toThrow(/intro/);
	});

	it("requires request opt-in and rejects disallowed request origins", () => {
		expect(() =>
			validate(withSteps([{ kind: "request", method: "POST", path: "/seed" }])),
		).toThrow(/allow-state-requests/);
		for (const requestPath of [
			"javascript:alert(1)",
			"https://user:secret@app.example.com/",
			"https://other.example/",
			"http://app.example.com/",
		]) {
			expect(() =>
				validate(
					withSteps([{ kind: "request", method: "GET", path: requestPath }]),
					{ allowStateRequests: true },
				),
			).toThrow(/intro.*step 0/);
		}
	});

	it("shares allowed-host/subdomain rules with the runtime origin gate", () => {
		const gate = createShowcaseOriginGate(
			"https://app.example.com/",
			config({ allowedHosts: ["extra.test"], includeSubdomains: true }),
		);
		expect(gate(new URL("https://child.extra.test/"))).toBe(true);
		expect(gate(new URL("https://www.app.example.com/"))).toBe(true);
		expect(gate(new URL("https://unexpected.test/"))).toBe(false);
		expect(gate(new URL("http://extra.test/"))).toBe(false);
		expect(gate(new URL("https://extra.test:8443/"))).toBe(false);
		expect(gate(new URL("https://user:secret@extra.test/"))).toBe(false);
		expect(gate(new URL("file:///tmp/a"))).toBe(false);
	});

	it.each(
		[
			[],
			[{ name: "../desktop", width: 1920, height: 1080 }],
			[
				{ name: "desktop", width: 1920, height: 1080 },
				{ name: "desktop", width: 1280, height: 720 },
			],
			[{ name: "desktop", width: 63, height: 1080 }],
			[{ name: "desktop", width: 1920, height: 4097 }],
			Array.from({ length: 9 }, (_, i) => ({
				name: `view-${i}`,
				width: 1920,
				height: 1080,
			})),
		].map((viewports) => ({ viewports })),
	)("rejects unsafe or unbounded viewport lists (case %#)", ({ viewports }) => {
		expect(() => validate(file(), { viewports })).toThrow(/viewport/i);
	});

	it("permits odd dimensions for the exporter to pad", () => {
		expect(() =>
			validate(file(), {
				viewports: [{ name: "mobile", width: 375, height: 667 }],
			}),
		).not.toThrow();
	});

	it("revalidates raw library data instead of trusting a TypeScript type", () => {
		const invalid = { ...parse(), name: "../escape" };
		expect(() =>
			validateShowcase(invalid, "https://app.example.com/", config()),
		).toThrow(/name/);
	});
});
