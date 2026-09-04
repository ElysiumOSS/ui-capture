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

/**
 * The scripted-state driver: the only place a `Page` is touched on behalf of a
 * states file. What a step *means* is decided in `state-plan.ts`, which has no
 * Playwright import, so the vocabulary is testable without a browser.
 *
 * No user-supplied code ever crosses into the page. There is no `evaluate`
 * step, and even `waitFor` with `minCount` polls `locator.count()` from here
 * rather than injecting a predicate, so the invariant holds literally.
 */

import { Effect, Ref } from "effect";
import type { Locator, Page } from "playwright";
import { StateCaptureError } from "./errors.js";
import type { CaptureStep } from "./schemas.js";
import {
	type ElementState,
	isExpectedStatus,
	type PlannedStep,
	planStep,
	type StepPlan,
	StepPlanError,
} from "./state-plan.js";

/** How much of a failing response body a failure message quotes. */
const RESPONSE_BODY_EXCERPT = 200;

/** Default budget for the `precondition` probe on the freshly loaded page. */
const DEFAULT_PRECONDITION_TIMEOUT_MS = 5000;

/**
 * The step a state is currently on. Held in a `Ref` so the whole-state timeout
 * can name the step that was actually running — "hung on step 4
 * (waitFor .fleet-row)" rather than the useless "state timed out".
 */
export interface StepProgress {
	readonly index: number;
	readonly kind: string;
	readonly target: string;
}

/** Before any step runs: navigation, or the state as a whole. */
export const INITIAL_STEP_PROGRESS: StepProgress = {
	index: -1,
	kind: "state",
	target: "",
};

export interface ScriptedStateRunner {
	readonly runStateScript: (
		page: Page,
		stateName: string,
		steps: ReadonlyArray<CaptureStep>,
		progress: Ref.Ref<StepProgress>,
	) => Effect.Effect<void, StateCaptureError>;
	readonly checkPrecondition: (
		page: Page,
		selector: string,
	) => Effect.Effect<boolean>;
}

export interface ScriptedStateRunnerOptions {
	/** Action default when a step omits `timeoutMs`. */
	readonly defaultStepTimeoutMs?: number;
	readonly preconditionTimeoutMs?: number;
}

const errorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		const [first] = error.message.split("\n");
		return first?.trim() || error.message;
	}
	return String(error);
};

const countMatching = async (
	locator: Locator,
	state: ElementState,
): Promise<number> => {
	const total = await locator.count();
	if (state === "attached") return total;
	if (state === "detached") return total === 0 ? 1 : 0;
	let matched = 0;
	for (let i = 0; i < total; i++) {
		const visible = await locator.nth(i).isVisible();
		if (state === "visible" ? visible : !visible) matched += 1;
	}
	return matched;
};

/**
 * Two page-manipulation toolkits are built from the same config and sit side
 * by side in the service: `createLinkDiscoveryTools` opens menus so links
 * become *discoverable*, and this one performs a named script so a state
 * becomes *capturable*. Neither owns the other, and `menuInteractionSelectors`
 * is not a capture-state mechanism.
 */
export const createScriptedStateRunner = (
	options: ScriptedStateRunnerOptions = {},
): ScriptedStateRunner => {
	const { defaultStepTimeoutMs, preconditionTimeoutMs } = options;

	const stepError = (
		stateName: string,
		index: number,
		kind: string,
		target: string,
		label: string,
		message: string,
		cause: unknown,
	): StateCaptureError =>
		new StateCaptureError({
			state: stateName,
			stepIndex: index,
			stepKind: kind,
			target,
			message: `state "${stateName}" failed at step ${index} (${label}): ${message}`,
			cause,
		});

	const runPlan = (
		page: Page,
		plan: StepPlan,
		fail: (message: string, cause: unknown) => StateCaptureError,
	): Effect.Effect<void, StateCaptureError> => {
		switch (plan.op) {
			case "sleep":
				return Effect.sleep(plan.ms);

			case "waitForSelector":
				return Effect.tryPromise({
					try: () =>
						page
							.locator(plan.selector)
							.first()
							.waitFor({ state: plan.state, timeout: plan.timeoutMs }),
					catch: (error) =>
						fail(
							`never became ${plan.state} within ${plan.timeoutMs}ms (${errorMessage(error)})`,
							error,
						),
				});

			case "waitForCount":
				return Effect.tryPromise({
					try: async () => {
						const locator = page.locator(plan.selector);
						const deadline = Date.now() + plan.timeoutMs;
						let found = 0;
						for (;;) {
							found = await countMatching(locator, plan.state);
							if (found >= plan.minCount) return;
							if (Date.now() >= deadline) {
								throw new Error(
									`expected >=${plan.minCount} matching "${plan.state}", found ${found} after ${plan.timeoutMs}ms`,
								);
							}
							await page.waitForTimeout(plan.pollMs);
						}
					},
					catch: (error) => fail(errorMessage(error), error),
				});

			case "click":
				return Effect.tryPromise({
					try: () =>
						page
							.locator(plan.selector)
							.nth(plan.nth)
							.click({ timeout: plan.timeoutMs }),
					catch: (error) => fail(errorMessage(error), error),
				});

			case "fill":
				return Effect.tryPromise({
					try: () =>
						page
							.locator(plan.selector)
							.first()
							.fill(plan.value, { timeout: plan.timeoutMs }),
					catch: (error) => fail(errorMessage(error), error),
				});

			case "select":
				return Effect.tryPromise({
					try: () =>
						page
							.locator(plan.selector)
							.first()
							.selectOption([...plan.values], { timeout: plan.timeoutMs })
							.then(() => undefined),
					catch: (error) => fail(errorMessage(error), error),
				});

			case "press":
				return Effect.tryPromise({
					try: () =>
						plan.selector === undefined
							? page.keyboard.press(plan.key)
							: page
									.locator(plan.selector)
									.first()
									.press(plan.key, { timeout: plan.timeoutMs }),
					catch: (error) => fail(errorMessage(error), error),
				});

			case "reload":
				return Effect.tryPromise({
					try: () =>
						page
							.reload({ waitUntil: plan.waitUntil, timeout: plan.timeoutMs })
							.then(() => undefined),
					catch: (error) => fail(errorMessage(error), error),
				});

			case "request":
				return Effect.tryPromise({
					try: async () => {
						const response = await page.request.fetch(plan.url, {
							method: plan.method,
							timeout: plan.timeoutMs,
							headers: plan.headers,
							...(plan.hasJson ? { data: plan.json } : {}),
						});
						if (isExpectedStatus(response.status(), plan.expectStatus)) return;
						let body = "";
						try {
							body = (await response.text()).slice(0, RESPONSE_BODY_EXCERPT);
						} catch {
							body = "<unreadable body>";
						}
						throw new Error(
							`expected ${plan.expectStatus ?? "2xx"}, got ${response.status()} — ${body}`,
						);
					},
					catch: (error) => fail(errorMessage(error), error),
				});
		}
	};

	const runStateScript = (
		page: Page,
		stateName: string,
		steps: ReadonlyArray<CaptureStep>,
		progress: Ref.Ref<StepProgress>,
	): Effect.Effect<void, StateCaptureError> =>
		Effect.gen(function* () {
			for (const [index, step] of steps.entries()) {
				let planned: PlannedStep;
				try {
					planned = planStep(step, {
						pageUrl: page.url(),
						defaultTimeoutMs: defaultStepTimeoutMs,
					});
				} catch (error) {
					const kind = error instanceof StepPlanError ? error.kind : step.kind;
					const target =
						error instanceof StepPlanError ? error.target : String(step.kind);
					return yield* Effect.fail(
						stepError(
							stateName,
							index,
							kind,
							target,
							`${step.kind} ${target}`,
							errorMessage(error),
							error,
						),
					);
				}

				yield* Ref.set(progress, {
					index,
					kind: planned.kind,
					target: planned.target,
				});

				const fail = (message: string, cause: unknown) =>
					stepError(
						stateName,
						index,
						planned.kind,
						planned.target,
						planned.label,
						message,
						cause,
					);

				const attempt = runPlan(page, planned.plan, fail);

				if (planned.optional) {
					yield* attempt.pipe(
						Effect.catchAll((error) => {
							console.warn(
								`  ! step ${index} (${planned.label}) failed (optional) — continuing: ${error.message}`,
							);
							return Effect.void;
						}),
					);
				} else {
					yield* attempt;
				}

				if (planned.settleMs > 0) {
					yield* Effect.sleep(planned.settleMs);
				}
			}
		});

	const checkPrecondition = (
		page: Page,
		selector: string,
	): Effect.Effect<boolean> =>
		Effect.tryPromise({
			try: async () => {
				await page
					.locator(selector)
					.first()
					.waitFor({
						state: "visible",
						timeout: preconditionTimeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS,
					});
				return true;
			},
			catch: (error) => error,
		}).pipe(Effect.catchAll(() => Effect.succeed(false)));

	return { runStateScript, checkPrecondition } as const;
};
