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
import { Cause, Effect, Exit, Ref } from "effect";
import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import type { StateCaptureError } from "./errors.js";
import {
	CaptureConfig,
	type CaptureStep,
	CaptureStep as CaptureStepSchema,
	DEFAULT_PRECONDITION_TIMEOUT_MS,
} from "./schemas.js";
import {
	createScriptedStateRunner,
	INITIAL_STEP_PROGRESS,
	type ScriptedStateRunnerOptions,
	type StepProgress,
} from "./state-script.js";

const decodeStep = S.decodeUnknownSync(CaptureStepSchema);

/**
 * The step engine is exercised against a hand-rolled `Page` rather than a real
 * browser. That is only possible because `state-plan.ts` decides what a step
 * *means* without Playwright, so this file only has to prove the driver calls
 * the right API with the right arguments and maps every rejection onto a
 * `StateCaptureError` naming the step.
 */
interface ElementBehaviour {
	/** How many elements the selector matches. */
	readonly count?: number;
	/** Successive `count()` answers; the last repeats once exhausted. */
	readonly counts?: readonly number[];
	/** Per-index visibility; missing indices are visible. */
	readonly visible?: readonly boolean[];
	/** Delay each `isVisible()` answer, to make a counting pass slow. */
	readonly visibleDelayMs?: number;
	/** `count()` never settles at all. */
	readonly countHangs?: boolean;
	/**
	 * `count()` rejects with this message — how a malformed selector behaves:
	 * real Playwright rejects with "Unexpected token ... while parsing css
	 * selector" whether or not any element would have matched.
	 */
	readonly countRejects?: string;
	/** When set, the corresponding action rejects with this message. */
	readonly waitFor?: string;
	readonly click?: string;
	readonly fill?: string;
	readonly select?: string;
	readonly press?: string;
}

interface FakePageOptions {
	readonly url?: string;
	readonly elements?: Record<string, ElementBehaviour>;
	readonly reload?: string;
	readonly request?: {
		readonly status?: number;
		readonly body?: string;
		readonly reject?: string;
	};
}

interface RecordedCall {
	readonly op: string;
	readonly [key: string]: unknown;
}

const createFakePage = (
	options: FakePageOptions = {},
): { page: Page; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	const pollCursor = new Map<string, number>();

	const behaviourFor = (selector: string): ElementBehaviour =>
		options.elements?.[selector] ?? {};

	const reject = (message: string) => Promise.reject(new Error(message));

	const element = (selector: string, index: number) => ({
		waitFor: (opts: { state: string; timeout: number }) => {
			calls.push({ op: "waitFor", selector, index, ...opts });
			const failure = behaviourFor(selector).waitFor;
			return failure ? reject(failure) : Promise.resolve();
		},
		click: (opts: { timeout: number }) => {
			calls.push({ op: "click", selector, index, ...opts });
			const failure = behaviourFor(selector).click;
			return failure ? reject(failure) : Promise.resolve();
		},
		fill: (value: string, opts: { timeout: number }) => {
			calls.push({ op: "fill", selector, index, value, ...opts });
			const failure = behaviourFor(selector).fill;
			return failure ? reject(failure) : Promise.resolve();
		},
		selectOption: (values: string[], opts: { timeout: number }) => {
			calls.push({ op: "select", selector, index, values, ...opts });
			const failure = behaviourFor(selector).select;
			return failure ? reject(failure) : Promise.resolve(values);
		},
		press: (key: string, opts: { timeout: number }) => {
			calls.push({ op: "press", selector, index, key, ...opts });
			const failure = behaviourFor(selector).press;
			return failure ? reject(failure) : Promise.resolve();
		},
		isVisible: () => {
			const behaviour = behaviourFor(selector);
			const visible = behaviour.visible?.[index] ?? true;
			calls.push({ op: "isVisible", selector, index, visible });
			return behaviour.visibleDelayMs === undefined
				? Promise.resolve(visible)
				: new Promise<boolean>((resolve) =>
						setTimeout(() => resolve(visible), behaviour.visibleDelayMs),
					);
		},
	});

	const locator = (selector: string) => ({
		first: () => element(selector, 0),
		nth: (index: number) => element(selector, index),
		count: () => {
			const behaviour = behaviourFor(selector);
			if (behaviour.countHangs) {
				calls.push({ op: "count", selector, hung: true });
				return new Promise<number>(() => {});
			}
			if (behaviour.countRejects) {
				calls.push({ op: "count", selector, rejected: behaviour.countRejects });
				return reject(behaviour.countRejects);
			}
			if (behaviour.counts) {
				const cursor = pollCursor.get(selector) ?? 0;
				pollCursor.set(selector, cursor + 1);
				const value =
					behaviour.counts[Math.min(cursor, behaviour.counts.length - 1)] ?? 0;
				calls.push({ op: "count", selector, value });
				return Promise.resolve(value);
			}
			const value = behaviour.count ?? 1;
			calls.push({ op: "count", selector, value });
			return Promise.resolve(value);
		},
	});

	const page = {
		url: () => options.url ?? "https://app.example.com/console",
		locator,
		keyboard: {
			press: (key: string) => {
				calls.push({ op: "keyboard.press", key });
				return Promise.resolve();
			},
		},
		reload: (opts: { waitUntil: string; timeout: number }) => {
			calls.push({ op: "reload", ...opts });
			return options.reload
				? reject(options.reload)
				: Promise.resolve(undefined);
		},
		waitForTimeout: (ms: number) => {
			calls.push({ op: "waitForTimeout", ms });
			return new Promise<void>((resolve) => setTimeout(resolve, ms));
		},
		request: {
			fetch: (url: string, opts: Record<string, unknown>) => {
				calls.push({ op: "request", url, ...opts });
				if (options.request?.reject) return reject(options.request.reject);
				return Promise.resolve({
					status: () => options.request?.status ?? 200,
					text: () => Promise.resolve(options.request?.body ?? ""),
				});
			},
		},
		// The vocabulary admits no `evaluate` step and `minCount` polls
		// `locator.count()` from Node, so no user-supplied code — and in fact no
		// code at all — ever crosses into the page.
		evaluate: () => {
			throw new Error("the state runner must never evaluate in-page code");
		},
	} as unknown as Page;

	return { page, calls };
};

const run = async (
	page: Page,
	steps: readonly unknown[],
	options: ScriptedStateRunnerOptions = {},
): Promise<{
	readonly exit: Exit.Exit<void, StateCaptureError>;
	readonly progress: StepProgress;
}> => {
	const runner = createScriptedStateRunner(options);
	const progress = Effect.runSync(Ref.make(INITIAL_STEP_PROGRESS));
	const decoded: CaptureStep[] = steps.map((step) => decodeStep(step));
	const exit = await Effect.runPromiseExit(
		runner.runStateScript(page, "demo", decoded, progress),
	);
	return { exit, progress: Effect.runSync(Ref.get(progress)) };
};

const failureOf = (
	exit: Exit.Exit<void, StateCaptureError>,
): StateCaptureError => {
	if (Exit.isSuccess(exit)) throw new Error("expected the state to fail");
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag === "None") throw new Error("expected a typed failure");
	return failure.value;
};

const callsOfKind = (calls: readonly RecordedCall[], op: string) =>
	calls.filter((call) => call.op === op);

describe("runStateScript — waitFor", () => {
	it("waits for the first match in the requested DOM state", async () => {
		const { page, calls } = createFakePage();
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: "dialog#spawn", state: "visible" },
		]);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(calls).toEqual([
			{
				op: "waitFor",
				selector: "dialog#spawn",
				index: 0,
				state: "visible",
				timeout: 5000,
			},
		]);
	});

	it("fails the state, naming the step, when the selector never appears", async () => {
		const { page } = createFakePage({
			elements: { "#never": { waitFor: "Timeout 5000ms exceeded." } },
		});
		const { exit } = await run(page, [
			{ kind: "click", selector: "#open" },
			{ kind: "waitFor", selector: "#never", timeoutMs: 250 },
		]);
		const error = failureOf(exit);
		expect(error._tag).toBe("StateCaptureError");
		expect(error.stepIndex).toBe(1);
		expect(error.stepKind).toBe("waitFor");
		expect(error.target).toBe("#never");
		expect(error.message).toContain('state "demo" failed at step 1');
		expect(error.message).toContain('waitFor "#never"');
		expect(error.message).toContain("never became visible within 250ms");
	});

	it("passes a hidden-state wait straight through", async () => {
		const { page, calls } = createFakePage();
		await run(page, [
			{ kind: "waitFor", selector: ".spinner", state: "hidden" },
		]);
		expect(calls[0]).toMatchObject({ state: "hidden" });
	});
});

describe("runStateScript — waitFor with minCount", () => {
	it("polls locator.count() until enough elements match", async () => {
		const { page, calls } = createFakePage({
			elements: { ".fleet-row": { counts: [0, 2, 6] } },
		});
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: ".fleet-row", minCount: 6, timeoutMs: 4000 },
		]);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(callsOfKind(calls, "count")).toHaveLength(3);
		expect(callsOfKind(calls, "waitForTimeout")).toHaveLength(2);
	});

	it("reports how many it found, not merely that it timed out", async () => {
		const { page } = createFakePage({
			elements: { ".fleet-row": { count: 2 } },
		});
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: ".fleet-row", minCount: 6, timeoutMs: 150 },
		]);
		const error = failureOf(exit);
		expect(error.message).toContain('expected >=6 matching "visible", found 2');
	});

	it("counts only visible matches when the requested state is visible", async () => {
		const { page } = createFakePage({
			elements: { ".row": { count: 4, visible: [true, false, false, true] } },
		});
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: ".row", minCount: 3, timeoutMs: 150 },
		]);
		expect(failureOf(exit).message).toContain("found 2");
	});

	it("counts every match when the requested state is attached", async () => {
		const { page } = createFakePage({
			elements: { ".row": { count: 4, visible: [true, false, false, true] } },
		});
		const { exit } = await run(page, [
			{
				kind: "waitFor",
				selector: ".row",
				minCount: 3,
				state: "attached",
				timeoutMs: 150,
			},
		]);
		expect(Exit.isSuccess(exit)).toBe(true);
	});
});

describe("runStateScript — wait", () => {
	it("sleeps without touching the page", async () => {
		const { page, calls } = createFakePage();
		const started = Date.now();
		const { exit } = await run(page, [{ kind: "wait", ms: 40 }]);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(30);
		expect(calls).toEqual([]);
	});
});

describe("runStateScript — click", () => {
	it("clicks the first match by default", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "click", selector: "[data-testid='spawn']" }]);
		expect(calls[0]).toMatchObject({ op: "click", index: 0, timeout: 5000 });
	});

	it("clicks the nth match when asked", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "click", selector: ".fleet-row", nth: 2 }]);
		expect(calls[0]).toMatchObject({ op: "click", index: 2 });
	});

	it("fails the state when the element is not actionable", async () => {
		const { page } = createFakePage({
			elements: { "#gone": { click: "element is not attached to the DOM" } },
		});
		const error = failureOf(
			(await run(page, [{ kind: "click", selector: "#gone" }])).exit,
		);
		expect(error.stepKind).toBe("click");
		expect(error.message).toContain("not attached to the DOM");
	});
});

describe("runStateScript — fill", () => {
	it("fills the first match", async () => {
		const { page, calls } = createFakePage();
		await run(page, [
			{ kind: "fill", selector: "#callsign", value: "RESQ-01" },
		]);
		expect(calls[0]).toMatchObject({ op: "fill", value: "RESQ-01" });
	});

	it("fails the state on a readonly input", async () => {
		const { page } = createFakePage({
			elements: { "#ro": { fill: "Element is not editable" } },
		});
		const error = failureOf(
			(await run(page, [{ kind: "fill", selector: "#ro", value: "x" }])).exit,
		);
		expect(error.stepKind).toBe("fill");
		expect(error.message).toContain("not editable");
	});
});

describe("runStateScript — select", () => {
	it("drives a native select with the requested values", async () => {
		const { page, calls } = createFakePage();
		await run(page, [
			{ kind: "select", selector: "#drone-type", values: ["fixed-wing"] },
		]);
		expect(calls[0]).toMatchObject({ op: "select", values: ["fixed-wing"] });
	});

	it("fails the state when the option does not exist", async () => {
		const { page } = createFakePage({
			elements: { "#t": { select: "did not find some options" } },
		});
		const error = failureOf(
			(await run(page, [{ kind: "select", selector: "#t", values: ["nope"] }]))
				.exit,
		);
		expect(error.stepKind).toBe("select");
		expect(error.message).toContain("did not find some options");
	});
});

describe("runStateScript — press", () => {
	it("sends an untargeted key to the keyboard", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "press", key: "Escape" }]);
		expect(calls).toEqual([{ op: "keyboard.press", key: "Escape" }]);
	});

	it("sends a targeted key to the element", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "press", key: "Enter", selector: "#form" }]);
		expect(calls[0]).toMatchObject({
			op: "press",
			selector: "#form",
			key: "Enter",
		});
	});

	it("fails the state and names both key and selector", async () => {
		const { page } = createFakePage({
			elements: { "#form": { press: "Timeout exceeded" } },
		});
		const error = failureOf(
			(await run(page, [{ kind: "press", key: "Enter", selector: "#form" }]))
				.exit,
		);
		expect(error.target).toBe("Enter @ #form");
	});
});

describe("runStateScript — reload", () => {
	it("reloads with the configured wait condition", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "reload" }]);
		expect(calls[0]).toMatchObject({ op: "reload", waitUntil: "networkidle" });
	});

	it("fails the state when the reload does not settle", async () => {
		const { page } = createFakePage({ reload: "Navigation timeout" });
		const error = failureOf((await run(page, [{ kind: "reload" }])).exit);
		expect(error.stepKind).toBe("reload");
		expect(error.message).toContain("Navigation timeout");
	});
});

describe("runStateScript — request", () => {
	it("resolves the path against the page and sends the JSON body", async () => {
		const { page, calls } = createFakePage({
			url: "https://app.example.com/console",
			request: { status: 201 },
		});
		const { exit } = await run(page, [
			{
				kind: "request",
				method: "POST",
				path: "/api/sim/seed",
				json: { preset: "multidomain", count: 6 },
				expectStatus: 201,
			},
		]);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(calls[0]).toMatchObject({
			op: "request",
			url: "https://app.example.com/api/sim/seed",
			method: "POST",
			data: { preset: "multidomain", count: 6 },
		});
	});

	it("omits the body entirely when no json is supplied", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "request", method: "GET", path: "/api/ping" }]);
		expect(calls[0]).not.toHaveProperty("data");
	});

	it("forwards custom headers", async () => {
		const { page, calls } = createFakePage();
		await run(page, [
			{
				kind: "request",
				method: "GET",
				path: "/api/ping",
				headers: { "x-test": "1" },
			},
		]);
		expect(calls[0]).toMatchObject({ headers: { "x-test": "1" } });
	});

	it("fails the state on a non-2xx, quoting a truncated body", async () => {
		const { page } = createFakePage({
			request: { status: 500, body: "x".repeat(500) },
		});
		const error = failureOf(
			(
				await run(page, [
					{ kind: "request", method: "POST", path: "/api/seed" },
				])
			).exit,
		);
		expect(error.stepKind).toBe("request");
		expect(error.target).toBe("POST /api/seed");
		expect(error.message).toContain("expected 2xx, got 500");
		// A seed that silently 500s and then screenshots the empty state is
		// exactly the coverage lie this feature exists to eliminate.
		expect(error.message).toContain("xxx");
		expect(error.message.length).toBeLessThan(400);
	});

	it("fails the state when the status is not the expected one", async () => {
		const { page } = createFakePage({ request: { status: 200 } });
		const error = failureOf(
			(
				await run(page, [
					{
						kind: "request",
						method: "POST",
						path: "/api/seed",
						expectStatus: 201,
					},
				])
			).exit,
		);
		expect(error.message).toContain("expected 201, got 200");
	});

	it("fails the state when the transport itself fails", async () => {
		const { page } = createFakePage({ request: { reject: "socket hang up" } });
		const error = failureOf(
			(await run(page, [{ kind: "request", method: "GET", path: "/api/x" }]))
				.exit,
		);
		expect(error.message).toContain("socket hang up");
	});

	it("fails the state when the path cannot be planned into a URL", async () => {
		const { page } = createFakePage();
		const { exit } = await run(page, [
			{ kind: "request", method: "GET", path: "file:///etc/passwd" },
		]);
		const error = failureOf(exit);
		expect(error.stepIndex).toBe(0);
		expect(error.stepKind).toBe("request");
		expect(error.message).toContain("unsupported scheme");
	});
});

describe("runStateScript — modifiers", () => {
	it("logs and skips an optional step instead of failing the state", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { page, calls } = createFakePage({
			elements: { "#banner": { click: "no such element" } },
		});
		const { exit } = await run(page, [
			{ kind: "click", selector: "#banner", optional: true },
			{ kind: "click", selector: "#next" },
		]);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(callsOfKind(calls, "click")).toHaveLength(2);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("(optional) — continuing"),
		);
		warn.mockRestore();
	});

	it("pauses for settleMs after the step succeeds", async () => {
		const { page } = createFakePage();
		const started = Date.now();
		await run(page, [{ kind: "click", selector: "#a", settleMs: 60 }]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(45);
	});

	it("still settles after an optional step was skipped", () => {
		// The pause describes the page, not the outcome, so it runs either way;
		// what must not happen is the state failing.
		return (async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { page } = createFakePage({
				elements: { "#a": { click: "nope" } },
			});
			const started = Date.now();
			const { exit } = await run(page, [
				{ kind: "click", selector: "#a", optional: true, settleMs: 60 },
			]);
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(Date.now() - started).toBeGreaterThanOrEqual(45);
			warn.mockRestore();
		})();
	});

	it("applies the caller's action default when a step omits timeoutMs", async () => {
		const { page, calls } = createFakePage();
		await run(page, [{ kind: "click", selector: "#a" }], {
			defaultStepTimeoutMs: 11000,
		});
		expect(calls[0]).toMatchObject({ timeout: 11000 });
	});
});

describe("runStateScript — sequencing and progress", () => {
	it("runs steps in order and stops at the first hard failure", async () => {
		const { page, calls } = createFakePage({
			elements: { "#b": { click: "boom" } },
		});
		const { exit } = await run(page, [
			{ kind: "click", selector: "#a" },
			{ kind: "click", selector: "#b" },
			{ kind: "click", selector: "#c" },
		]);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(callsOfKind(calls, "click").map((call) => call.selector)).toEqual([
			"#a",
			"#b",
		]);
	});

	it("leaves the progress ref on the step that was actually running", async () => {
		// This is what turns "state timed out" into "hung on step 2
		// (waitFor .fleet-row)" when the whole-state budget expires.
		const { page } = createFakePage({
			elements: { ".fleet-row": { waitFor: "Timeout" } },
		});
		const { progress } = await run(page, [
			{ kind: "click", selector: "#a" },
			{ kind: "reload" },
			{ kind: "waitFor", selector: ".fleet-row", timeoutMs: 100 },
		]);
		expect(progress).toEqual({
			index: 2,
			kind: "waitFor",
			target: ".fleet-row",
			phase: "step",
		});
	});

	it("starts from a whole-state progress marker before any step runs", async () => {
		expect(INITIAL_STEP_PROGRESS.index).toBe(-1);
		expect(INITIAL_STEP_PROGRESS.kind).toBe("state");
		expect(INITIAL_STEP_PROGRESS.phase).toBe("navigate");
	});

	it("marks the script done rather than leaving the last step named", async () => {
		// Updated with the phase field: an empty script *completes*, so leaving
		// the ref on the pre-navigation marker would have the whole-state
		// timeout report a state that finished its script as still navigating.
		const { page } = createFakePage();
		const { progress } = await run(page, []);
		expect(progress).toEqual({ ...INITIAL_STEP_PROGRESS, phase: "done" });
	});

	it("names the last step as settling, not running, during its settleMs", async () => {
		// The off-by-one this closes: the ref still named step 0 for the whole
		// of its settle delay, so a budget that expired there blamed a step
		// that had already succeeded.
		const { page } = createFakePage();
		const runner = createScriptedStateRunner();
		const progress = Effect.runSync(Ref.make(INITIAL_STEP_PROGRESS));
		await Effect.runPromiseExit(
			runner
				.runStateScript(
					page,
					"demo",
					[decodeStep({ kind: "click", selector: "#a", settleMs: 5000 })],
					progress,
				)
				.pipe(Effect.timeout(50)),
		);
		expect(Effect.runSync(Ref.get(progress))).toEqual({
			index: 0,
			kind: "click",
			target: "#a",
			phase: "settle",
		});
	});
});

describe("checkPrecondition", () => {
	it("evaluates the selector before it starts waiting on it", async () => {
		// The `count()` is not incidental: it is the whole discriminator. A
		// malformed selector rejects there whether or not an element would have
		// matched, which is what separates "not present here" from "this
		// selector is broken" without any page-side evaluation.
		const { page, calls } = createFakePage();
		const runner = createScriptedStateRunner({ preconditionTimeoutMs: 1234 });
		await expect(
			Effect.runPromise(
				runner.checkPrecondition(page, "demo", "[data-advanced]"),
			),
		).resolves.toBe(true);
		expect(calls[0]).toMatchObject({
			op: "count",
			selector: "[data-advanced]",
		});
		expect(calls[1]).toMatchObject({
			op: "waitFor",
			state: "visible",
			timeout: 1234,
		});
	});

	it("is false — not an error — when the selector is absent", async () => {
		// "This state does not exist here" is a different event from "this
		// state's script is broken", and only the second is a failure.
		const { page } = createFakePage({
			elements: { "[data-advanced]": { waitFor: "Timeout 50ms exceeded." } },
		});
		const runner = createScriptedStateRunner({ preconditionTimeoutMs: 50 });
		await expect(
			Effect.runPromise(
				runner.checkPrecondition(page, "demo", "[data-advanced]"),
			),
		).resolves.toBe(false);
	});

	it("fails the state when the selector cannot be evaluated at all", async () => {
		// The failure this exists to prevent: a typo'd selector answering "not
		// present here", the state skipping, and the run going green having
		// captured nothing.
		const { page } = createFakePage({
			elements: {
				"##typo": {
					countRejects:
						'locator.count: Unexpected token "#" while parsing css selector "##typo".',
				},
			},
		});
		const runner = createScriptedStateRunner({ preconditionTimeoutMs: 50 });
		const exit = await Effect.runPromiseExit(
			runner.checkPrecondition(page, "demo", "##typo"),
		);
		const error = failureOf(exit as Exit.Exit<void, StateCaptureError>);
		expect(error._tag).toBe("StateCaptureError");
		expect(error.stepKind).toBe("precondition");
		expect(error.stepIndex).toBe(-1);
		expect(error.target).toBe("##typo");
		expect(error.message).toContain("could not evaluate its precondition");
		expect(error.message).toContain("while parsing css selector");
	});

	it("fails, rather than skipping, when the wait dies for a non-timeout reason", async () => {
		const { page } = createFakePage({
			elements: {
				"[data-advanced]": {
					waitFor: "Target page, context or browser has been closed",
				},
			},
		});
		const runner = createScriptedStateRunner({ preconditionTimeoutMs: 50 });
		const exit = await Effect.runPromiseExit(
			runner.checkPrecondition(page, "demo", "[data-advanced]"),
		);
		expect(
			failureOf(exit as Exit.Exit<void, StateCaptureError>).message,
		).toContain("has been closed");
	});

	it("lets a state override the run's probe budget", async () => {
		const { page, calls } = createFakePage();
		const runner = createScriptedStateRunner({ preconditionTimeoutMs: 1000 });
		await Effect.runPromise(
			runner.checkPrecondition(page, "demo", "[data-advanced]", 25000),
		);
		expect(callsOfKind(calls, "waitFor")[0]).toMatchObject({ timeout: 25000 });
	});

	it("falls back to the shared default when nothing configures it", async () => {
		// Ten seconds, not five: the probe runs after `networkidle`, which is a
		// network fact rather than a rendering one, and an app that reaches its
		// first meaningful frame later than the probe is reported as *absent*.
		const { page, calls } = createFakePage();
		await Effect.runPromise(
			createScriptedStateRunner({}).checkPrecondition(
				page,
				"demo",
				"[data-advanced]",
			),
		);
		expect(callsOfKind(calls, "waitFor")[0]).toMatchObject({
			timeout: DEFAULT_PRECONDITION_TIMEOUT_MS,
		});
		// The config default and the driver fallback are the same constant; this
		// is what stops them drifting apart in opposite directions.
		expect(CaptureConfig.Default.preconditionTimeout).toBe(
			DEFAULT_PRECONDITION_TIMEOUT_MS,
		);
	});
});

describe("runStateScript — the request host gate", () => {
	it("judges the URL the step resolves to against the live page, not the configured one", async () => {
		// The bypass this closes: a script navigates somewhere else first, so a
		// relative path resolves against an origin the pre-launch check never
		// saw. The gate has to run where the resolution happens.
		const { page } = createFakePage({ url: "https://evil.test/landing" });
		const { exit } = await run(
			page,
			[{ kind: "request", method: "POST", path: "/api/seed" }],
			{ isAllowedRequestUrl: (url) => url.hostname === "app.example.com" },
		);
		const error = failureOf(exit);
		expect(error.stepKind).toBe("request");
		expect(error.target).toBe("POST /api/seed");
		expect(error.message).toContain("https://evil.test/api/seed");
		expect(error.message).toContain("outside the allowed origins");
	});

	it("sends nothing when the gate rejects", async () => {
		const { page, calls } = createFakePage({
			url: "https://evil.test/landing",
		});
		await run(
			page,
			[{ kind: "request", method: "DELETE", path: "/api/fleet" }],
			{
				isAllowedRequestUrl: (url) => url.hostname === "app.example.com",
			},
		);
		expect(callsOfKind(calls, "request")).toHaveLength(0);
	});

	it("allows a request the gate accepts", async () => {
		const { page, calls } = createFakePage({
			url: "https://app.example.com/console",
		});
		const { exit } = await run(
			page,
			[{ kind: "request", method: "GET", path: "/api/ping" }],
			{ isAllowedRequestUrl: (url) => url.hostname === "app.example.com" },
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(callsOfKind(calls, "request")).toHaveLength(1);
	});

	it("does not widen to another port on an allowed host", async () => {
		// The reason the gate takes a URL rather than a hostname: the pre-launch
		// pass compares scheme, host *and* port, so a script that navigates to
		// another port on the same host must not be able to reach a backend the
		// validated file could not.
		const { page, calls } = createFakePage({
			url: "https://app.example.com:9000/console",
		});
		const { exit } = await run(
			page,
			[{ kind: "request", method: "POST", path: "/api/seed" }],
			{
				isAllowedRequestUrl: (url) => url.origin === "https://app.example.com",
			},
		);
		expect(failureOf(exit).message).toContain("outside the allowed origins");
		expect(callsOfKind(calls, "request")).toHaveLength(0);
	});

	it("falls back to the page's own origin when no gate is configured", async () => {
		// Fail closed. A caller that forgets to pass a filter gets the property
		// the `path` form is supposed to guarantee, not an open door.
		const { page, calls } = createFakePage({
			url: "https://app.example.com/console",
		});
		const { exit } = await run(page, [
			{ kind: "request", method: "POST", path: "https://other.test/api/seed" },
		]);
		expect(failureOf(exit).message).toContain("outside the allowed origins");
		expect(callsOfKind(calls, "request")).toHaveLength(0);
	});

	it("denies everything when the page URL will not parse", async () => {
		// about:blank and friends: nothing to be same-origin with, so nothing is.
		const { page, calls } = createFakePage({ url: "about:blank" });
		const { exit } = await run(page, [
			{ kind: "request", method: "GET", path: "https://app.example.com/api" },
		]);
		expect(failureOf(exit).message).toContain("outside the allowed origins");
		expect(callsOfKind(calls, "request")).toHaveLength(0);
	});
});

describe("runStateScript — inexpressible step shapes", () => {
	it("refuses minCount with a state that also passes on no match", async () => {
		for (const state of ["hidden", "detached"] as const) {
			const { page, calls } = createFakePage();
			const { exit } = await run(page, [
				{ kind: "waitFor", selector: ".row", state, minCount: 3 },
			]);
			const error = failureOf(exit);
			expect(error.stepKind).toBe("waitFor");
			expect(error.message).toContain("minCount counts matching elements");
			expect(error.message).toContain(`state "${state}"`);
			// Refused, not attempted with one of the two meanings guessed at.
			expect(calls).toEqual([]);
		}
	});

	it("still allows minCount with visible and attached", async () => {
		for (const state of ["visible", "attached"] as const) {
			const { page } = createFakePage({ elements: { ".row": { count: 4 } } });
			const { exit } = await run(page, [
				{ kind: "waitFor", selector: ".row", state, minCount: 3 },
			]);
			expect(Exit.isSuccess(exit)).toBe(true);
		}
	});

	it("refuses a timeoutMs on a press that has no element to wait for", async () => {
		const { page, calls } = createFakePage();
		const { exit } = await run(page, [
			{ kind: "press", key: "Escape", timeoutMs: 9000 },
		]);
		const error = failureOf(exit);
		expect(error.stepKind).toBe("press");
		expect(error.message).toContain("timeoutMs has no effect on an untargeted");
		expect(calls).toEqual([]);
	});

	it("leaves an untargeted press without a timeout alone", async () => {
		const { page, calls } = createFakePage();
		const { exit } = await run(page, [{ kind: "press", key: "Escape" }], {
			defaultStepTimeoutMs: 9000,
		});
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(calls).toEqual([{ op: "keyboard.press", key: "Escape" }]);
	});

	it("keeps honouring timeoutMs on a targeted press", async () => {
		const { page, calls } = createFakePage();
		await run(page, [
			{ kind: "press", key: "Enter", selector: "#form", timeoutMs: 900 },
		]);
		expect(calls[0]).toMatchObject({ op: "press", timeout: 900 });
	});
});

describe("runStateScript — a counting pass respects its own deadline", () => {
	it("stops inspecting matches once the step's timeout has passed", async () => {
		// A pass that began inside the budget must not run on past it: one round
		// trip per match means a selector matching enough elements would
		// otherwise outlive the step timeout entirely.
		const { page, calls } = createFakePage({
			elements: { ".row": { count: 40, visibleDelayMs: 20 } },
		});
		const started = Date.now();
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: ".row", minCount: 40, timeoutMs: 120 },
		]);
		const elapsed = Date.now() - started;
		const error = failureOf(exit);
		expect(error.message).toContain("the step deadline passed");
		expect(error.message).toContain("of 40 checked");
		// 40 × 20ms is 800ms of inspection; the deadline is 120ms.
		expect(elapsed).toBeLessThan(500);
		expect(callsOfKind(calls, "isVisible").length).toBeLessThan(40);
	});

	it("gives up on a page call that never settles at all", async () => {
		// No in-loop deadline can reach a promise that never resolves, so the
		// counting pass carries a hard backstop; without it the step outlives
		// its own timeout and eats the whole-state budget instead.
		const { page } = createFakePage({
			elements: { ".row": { countHangs: true } },
		});
		const started = Date.now();
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: ".row", minCount: 1, timeoutMs: 100 },
		]);
		const error = failureOf(exit);
		expect(error.stepKind).toBe("waitFor");
		expect(error.message).toContain("never settled");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("still reports the last count taken while the step could run", async () => {
		// The deadline check must not degrade the message into "found 0": the
		// count worth reading is the last one taken inside the budget.
		const { page } = createFakePage({
			elements: { ".row": { count: 4, visible: [true, false, false, true] } },
		});
		const { exit } = await run(page, [
			{ kind: "waitFor", selector: ".row", minCount: 3, timeoutMs: 150 },
		]);
		expect(failureOf(exit).message).toContain(
			'expected >=3 matching "visible", found 2',
		);
	});
});
