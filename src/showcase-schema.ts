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
import { ArrayFormatter, Schema as S } from "@effect/schema";
import { type CaptureConfig, CaptureStep } from "./schemas.js";
import { createHostFilterState, isAllowedOrigin } from "./shared.js";
import { resolveRequestUrl, stepShapeError } from "./state-plan.js";

const boundedInteger = (minimum: number, maximum: number) =>
	S.Number.pipe(S.int(), S.between(minimum, maximum));
const Name = S.String.pipe(S.pattern(/^[a-z0-9][a-z0-9-]*$/), S.maxLength(64));
const Text = S.String.pipe(S.maxLength(10000));
const Selector = S.String.pipe(S.minLength(1), S.maxLength(2000));
const StepFields = {
	optional: S.optionalWith(S.Boolean, { default: () => false }),
	timeoutMs: S.optional(boundedInteger(1, 60000)),
	settleMs: S.optional(boundedInteger(0, 60000)),
};

/** Timed text entry on the one fixed viewport being recorded. */
const TypeStep = S.Struct({
	kind: S.Literal("type"),
	selector: Selector,
	value: Text,
	delayMs: S.optionalWith(boundedInteger(0, 1000), { default: () => 80 }),
	clear: S.optionalWith(S.Boolean, { default: () => true }),
	...StepFields,
});

const HoverStep = S.Struct({
	kind: S.Literal("hover"),
	selector: Selector,
	nth: S.optionalWith(boundedInteger(0, 100000), { default: () => 0 }),
	...StepFields,
});

/** Absolute document scroll positions; no injected user expressions. */
const ScrollStep = S.Struct({
	kind: S.Literal("scroll"),
	x: S.optionalWith(boundedInteger(0, 1000000), { default: () => 0 }),
	y: boundedInteger(0, 1000000),
	durationMs: S.optionalWith(boundedInteger(0, 10000), { default: () => 800 }),
	...StepFields,
});

/** Showcase-only transient actions leave the legacy state vocabulary intact. */
export const ShowcaseStep = S.Union(
	CaptureStep,
	TypeStep,
	HoverStep,
	ScrollStep,
);
export type ShowcaseStep = typeof ShowcaseStep.Type;

const ShowcaseScene = S.Struct({
	name: Name,
	url: S.optional(Text.pipe(S.minLength(1))),
	caption: S.optional(Text),
	readySelector: S.optional(Selector),
	timeoutMs: S.optionalWith(boundedInteger(1, 300000), {
		default: () => 60000,
	}),
	holdMs: S.optionalWith(boundedInteger(0, 60000), { default: () => 2000 }),
	steps: S.Array(ShowcaseStep).pipe(S.maxItems(200)),
});

/** Ordered scenes; an omitted later URL continues on the live page. */
export const ShowcaseFile = S.Struct({
	version: S.Literal(1),
	name: Name,
	title: S.optional(Text),
	cursor: S.optionalWith(S.Boolean, { default: () => true }),
	captions: S.optionalWith(S.Boolean, { default: () => true }),
	timeoutMs: S.optionalWith(boundedInteger(1, 900000), {
		default: () => 300000,
	}),
	scenes: S.Array(ShowcaseScene).pipe(S.minItems(1), S.maxItems(100)),
});
export type ShowcaseFile = typeof ShowcaseFile.Type;

const decode = S.decodeUnknownEither(ShowcaseFile, {
	onExcessProperty: "error",
	errors: "all",
});

const decodeShowcase = (value: unknown, label: string): ShowcaseFile => {
	const result = decode(value);
	if (result._tag === "Right") return result.right;
	const detail = ArrayFormatter.formatErrorSync(result.left)
		.map(
			(issue) =>
				`  ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
		)
		.join("\n");
	throw new Error(`Invalid showcase ${label}:\n${detail}`);
};

/** Decode strictly so a misspelled field cannot silently disappear. */
export const parseShowcaseFile = (
	contents: string,
	sourcePath: string,
): ShowcaseFile => {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new Error(
			`${sourcePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return decodeShowcase(value, sourcePath);
};

const isWebUrl = (url: URL): boolean =>
	(url.protocol === "http:" || url.protocol === "https:") &&
	url.username === "" &&
	url.password === "";

const webUrl = (value: string, label: string, base?: string): URL => {
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		throw new Error(`${label} is not a valid URL`);
	}
	if (!isWebUrl(url)) {
		throw new Error(
			`${label} must use http or https without embedded credentials`,
		);
	}
	return url;
};

/** Same scheme/port and host policy at preflight and at every runtime action. */
export const createShowcaseOriginGate = (
	seedUrl: string,
	config: CaptureConfig,
): ((url: URL) => boolean) => {
	const seed = webUrl(seedUrl, "showcase seed URL");
	const filters = createHostFilterState();
	filters.hydrate(seed.hostname, config.allowedHosts);
	return (candidate) =>
		isWebUrl(candidate) &&
		isAllowedOrigin(candidate, seed, (hostname) =>
			filters.hostMatchesFilters(hostname, config.includeSubdomains),
		);
};

const assertRange = (
	value: number,
	minimum: number,
	maximum: number,
	label: string,
): void => {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`${label} must be an integer between ${minimum} and ${maximum}`,
		);
	}
};

const assertText = (
	value: string,
	maximum: number,
	label: string,
	nonempty = false,
): void => {
	if (value.length > maximum || (nonempty && value.trim().length === 0)) {
		throw new Error(
			`${label} must be ${nonempty ? "nonempty and " : ""}at most ${maximum} characters`,
		);
	}
};

const assertStepBounds = (step: ShowcaseStep, label: string): void => {
	if (step.timeoutMs !== undefined)
		assertRange(step.timeoutMs, 1, 60000, `${label} timeoutMs`);
	if (step.settleMs !== undefined)
		assertRange(step.settleMs, 0, 60000, `${label} settleMs`);
	if ("selector" in step && step.selector !== undefined)
		assertText(step.selector, 2000, `${label} selector`, true);
	if ("value" in step) assertText(step.value, 10000, `${label} value`);
	if ("nth" in step && step.nth !== undefined)
		assertRange(step.nth, 0, 100000, `${label} nth`);
	if (step.kind === "wait") assertRange(step.ms, 0, 60000, `${label} ms`);
	if (step.kind === "waitFor" && step.minCount !== undefined)
		assertRange(step.minCount, 1, 100000, `${label} minCount`);
	if (step.kind === "press") assertText(step.key, 10000, `${label} key`, true);
	if (step.kind === "select") {
		if (step.values.length > 1000)
			throw new Error(`${label} values may contain at most 1000 entries`);
		for (const value of step.values)
			assertText(value, 10000, `${label} values`);
	}
	if (step.kind === "request") {
		assertText(step.path, 10000, `${label} path`, true);
		if (step.expectStatus !== undefined)
			assertRange(step.expectStatus, 100, 599, `${label} expectStatus`);
		for (const [key, value] of Object.entries(step.headers ?? {})) {
			assertText(key, 2000, `${label} header name`, true);
			assertText(value, 10000, `${label} header value`);
		}
	}
	if (step.kind !== "type" && step.kind !== "hover" && step.kind !== "scroll") {
		const error = stepShapeError(step);
		if (error !== undefined) throw new Error(`${label}: ${error}`);
	}
};

/** All static errors abort before Chromium launches; live redirects are gated again. */
export const validateShowcase = (
	input: ShowcaseFile,
	seedUrl: string,
	config: CaptureConfig,
): void => {
	// Library callers cannot bypass validation with a cast or mutated object.
	const showcase = decodeShowcase(input, "definition");
	const allowed = createShowcaseOriginGate(seedUrl, config);
	assertRange(config.viewports.length, 1, 8, "showcase viewport count");
	const viewportNames = new Set<string>();
	for (const viewport of config.viewports) {
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(viewport.name)) {
			throw new Error(`Invalid showcase viewport name "${viewport.name}"`);
		}
		if (viewportNames.has(viewport.name))
			throw new Error(`Duplicate showcase viewport name "${viewport.name}"`);
		viewportNames.add(viewport.name);
		assertRange(viewport.width, 64, 4096, `viewport "${viewport.name}" width`);
		assertRange(
			viewport.height,
			64,
			4096,
			`viewport "${viewport.name}" height`,
		);
	}

	const names = new Set<string>();
	let totalSteps = 0;
	let knownUrl = seedUrl;
	for (const scene of showcase.scenes) {
		const label = `scene "${scene.name}"`;
		if (names.has(scene.name))
			throw new Error(`Duplicate showcase scene name "${scene.name}"`);
		names.add(scene.name);
		totalSteps += scene.steps.length;
		if (totalSteps > 1000)
			throw new Error("A showcase may contain at most 1000 total steps");
		if (scene.readySelector !== undefined)
			assertText(scene.readySelector, 2000, `${label} readySelector`, true);
		if (scene.url !== undefined) {
			const url = webUrl(scene.url, `${label} URL`, seedUrl);
			if (!allowed(url))
				throw new Error(`${label} URL is outside the allowed origins`);
			knownUrl = url.toString();
		}
		for (const [index, step] of scene.steps.entries()) {
			const stepLabel = `${label} step ${index} (${step.kind})`;
			assertStepBounds(step, stepLabel);
			if (step.kind !== "request") continue;
			if (!config.allowStateRequests)
				throw new Error(
					`${stepLabel} requires --allow-state-requests (allowStateRequests: true)`,
				);
			let url: URL;
			try {
				url = resolveRequestUrl(step.path, knownUrl);
			} catch (error) {
				throw new Error(
					`${stepLabel}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!allowed(url))
				throw new Error(
					`${stepLabel} URL is outside the allowed origins or contains credentials`,
				);
		}
	}
};
