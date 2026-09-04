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

import { Schema as S } from "@effect/schema";
import { describe, expect, it } from "vitest";
import { CaptureStep } from "./schemas.js";
import {
	COUNT_POLL_INTERVAL_MS,
	DEFAULT_STEP_TIMEOUT_MS,
	describeStep,
	isExpectedStatus,
	planStep,
	resolveRequestUrl,
	StepPlanError,
} from "./state-plan.js";

const decodeStep = S.decodeUnknownSync(CaptureStep);
const PAGE = "https://app.example.com/console?mode=advanced";
const ctx = { pageUrl: PAGE };

describe("planStep — waitFor", () => {
	it("defaults to waiting for the first match to become visible", () => {
		const planned = planStep(
			decodeStep({ kind: "waitFor", selector: "#d" }),
			ctx,
		);
		expect(planned.plan).toEqual({
			op: "waitForSelector",
			selector: "#d",
			state: "visible",
			timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
		});
		expect(planned.optional).toBe(false);
		expect(planned.settleMs).toBe(0);
		expect(planned.label).toBe('waitFor "#d"');
	});

	it("honours an explicit DOM state and per-step timeout", () => {
		const planned = planStep(
			decodeStep({
				kind: "waitFor",
				selector: ".spinner",
				state: "hidden",
				timeoutMs: 20000,
			}),
			ctx,
		);
		expect(planned.plan).toMatchObject({ state: "hidden", timeoutMs: 20000 });
	});

	it("switches to a counting plan when minCount is set", () => {
		const planned = planStep(
			decodeStep({ kind: "waitFor", selector: ".fleet-row", minCount: 6 }),
			ctx,
		);
		expect(planned.plan).toEqual({
			op: "waitForCount",
			selector: ".fleet-row",
			minCount: 6,
			state: "visible",
			timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
			pollMs: COUNT_POLL_INTERVAL_MS,
		});
	});
});

describe("planStep — actions", () => {
	it("defaults click to the first match", () => {
		expect(
			planStep(decodeStep({ kind: "click", selector: "button" }), ctx).plan,
		).toEqual({
			op: "click",
			selector: "button",
			nth: 0,
			timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
		});
	});

	it("carries nth through", () => {
		expect(
			planStep(decodeStep({ kind: "click", selector: ".row", nth: 2 }), ctx)
				.plan,
		).toMatchObject({ nth: 2 });
	});

	it("plans fill and select verbatim", () => {
		expect(
			planStep(
				decodeStep({ kind: "fill", selector: "#callsign", value: "RESQ-01" }),
				ctx,
			).plan,
		).toMatchObject({ op: "fill", value: "RESQ-01" });
		expect(
			planStep(
				decodeStep({
					kind: "select",
					selector: "#drone-type",
					values: ["fixed-wing"],
				}),
				ctx,
			).plan,
		).toMatchObject({ op: "select", values: ["fixed-wing"] });
	});

	it("sends a keypress to the keyboard when no selector is given", () => {
		const planned = planStep(decodeStep({ kind: "press", key: "Escape" }), ctx);
		expect(planned.plan).toMatchObject({ op: "press", selector: undefined });
		expect(planned.target).toBe("Escape");
	});

	it("names both key and selector when the press is targeted", () => {
		expect(
			planStep(
				decodeStep({ kind: "press", key: "Enter", selector: "#form" }),
				ctx,
			).target,
		).toBe("Enter @ #form");
	});

	it("plans a bare wait as a sleep", () => {
		expect(planStep(decodeStep({ kind: "wait", ms: 400 }), ctx).plan).toEqual({
			op: "sleep",
			ms: 400,
		});
	});

	it("defaults reload to networkidle", () => {
		expect(planStep(decodeStep({ kind: "reload" }), ctx).plan).toMatchObject({
			op: "reload",
			waitUntil: "networkidle",
		});
	});
});

describe("planStep — modifiers", () => {
	it("carries optional and settleMs onto every kind", () => {
		const planned = planStep(
			decodeStep({
				kind: "click",
				selector: "#consent",
				optional: true,
				settleMs: 400,
			}),
			ctx,
		);
		expect(planned.optional).toBe(true);
		expect(planned.settleMs).toBe(400);
	});

	it("prefers a step timeout over the caller's action default", () => {
		expect(
			planStep(decodeStep({ kind: "click", selector: "b", timeoutMs: 900 }), {
				...ctx,
				defaultTimeoutMs: 12000,
			}).plan,
		).toMatchObject({ timeoutMs: 900 });
		expect(
			planStep(decodeStep({ kind: "click", selector: "b" }), {
				...ctx,
				defaultTimeoutMs: 12000,
			}).plan,
		).toMatchObject({ timeoutMs: 12000 });
	});
});

describe("planStep — request", () => {
	it("resolves a path against the page URL, making it same-origin", () => {
		const planned = planStep(
			decodeStep({ kind: "request", method: "POST", path: "/api/sim/seed" }),
			ctx,
		);
		expect(planned.plan).toMatchObject({
			op: "request",
			method: "POST",
			url: "https://app.example.com/api/sim/seed",
			hasJson: false,
		});
	});

	it("marks a body as present only when json is supplied", () => {
		expect(
			planStep(
				decodeStep({
					kind: "request",
					method: "POST",
					path: "/api/seed",
					json: { preset: "multidomain", count: 6 },
					expectStatus: 201,
				}),
				ctx,
			).plan,
		).toMatchObject({ hasJson: true, expectStatus: 201 });
	});

	it("copies headers rather than aliasing the step", () => {
		const step = decodeStep({
			kind: "request",
			method: "GET",
			path: "/api/x",
			headers: { "x-test": "1" },
		});
		const plan = planStep(step, ctx).plan;
		expect(plan).toMatchObject({ headers: { "x-test": "1" } });
	});

	it("rejects a non-http scheme", () => {
		expect(() => resolveRequestUrl("file:///etc/passwd", PAGE)).toThrow(
			StepPlanError,
		);
	});

	it("keeps an absolute URL as written, for the host filter to judge", () => {
		expect(resolveRequestUrl("https://other.test/api", PAGE).hostname).toBe(
			"other.test",
		);
	});
});

describe("describeStep", () => {
	it("quotes selectors and leaves verbs bare", () => {
		expect(describeStep(decodeStep({ kind: "click", selector: "#a" }))).toBe(
			'click "#a"',
		);
		expect(
			describeStep(
				decodeStep({ kind: "request", method: "POST", path: "/api/seed" }),
			),
		).toBe("request POST /api/seed");
		expect(describeStep(decodeStep({ kind: "wait", ms: 250 }))).toBe(
			"wait 250ms",
		);
	});
});

describe("isExpectedStatus", () => {
	it("accepts any 2xx by default and nothing else", () => {
		expect(isExpectedStatus(200, undefined)).toBe(true);
		expect(isExpectedStatus(204, undefined)).toBe(true);
		expect(isExpectedStatus(302, undefined)).toBe(false);
		expect(isExpectedStatus(500, undefined)).toBe(false);
	});

	it("demands an exact match when expectStatus is set", () => {
		expect(isExpectedStatus(201, 201)).toBe(true);
		expect(isExpectedStatus(200, 201)).toBe(false);
	});
});
