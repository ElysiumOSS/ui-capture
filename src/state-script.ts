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
import {
	type CaptureStep,
	DEFAULT_PRECONDITION_TIMEOUT_MS,
} from "./schemas.js";
import {
	type CountableState,
	isExpectedStatus,
	type PlannedStep,
	planStep,
	type StepPlan,
	StepPlanError,
} from "./state-plan.js";

/** How much of a failing response body a failure message quotes. */
const RESPONSE_BODY_EXCERPT = 200;

/**
 * Slack on the hard backstop around a `minCount` counting pass.
 *
 * The pass enforces its own deadline and produces the message worth reading
 * ("found 2 after 4000ms"), so the backstop has to lose that race in every
 * normal case. It exists for the pathological one: a single `count()` or
 * `isVisible()` that never settles, where the loop never reaches its own
 * check and the step would otherwise outlive its timeout entirely.
 */
const COUNT_BACKSTOP_GRACE_MS = 500;

/**
 * What a state is doing right now, not merely which step it last started.
 *
 * `index`/`kind`/`target` alone are ambiguous at a boundary: they still name
 * the last step for the whole of its settle delay and for everything that
 * happens after the script returns, so a budget that expired *there* would be
 * reported against a step that had already succeeded. `phase` is what makes
 * the reading honest.
 */
export type StepPhase =
	/** Loading the page, before any step. */
	| "navigate"
	/** Probing the state's `precondition` on the fresh load. */
	| "precondition"
	/** Inside the step named by `index`. */
	| "step"
	/** The step named by `index` succeeded; serving its `settleMs`. */
	| "settle"
	/** Every step finished. */
	| "done";

/**
 * The step a state is currently on. Held in a `Ref` so the whole-state timeout
 * can name the step that was actually running — "hung on step 4
 * (waitFor .fleet-row)" rather than the useless "state timed out".
 */
export interface StepProgress {
	readonly index: number;
	readonly kind: string;
	readonly target: string;
	readonly phase: StepPhase;
}

/** Before any step runs: navigation, or the state as a whole. */
export const INITIAL_STEP_PROGRESS: StepProgress = {
	index: -1,
	kind: "state",
	target: "",
	phase: "navigate",
};

export interface ScriptedStateRunner {
	readonly runStateScript: (
		page: Page,
		stateName: string,
		steps: ReadonlyArray<CaptureStep>,
		progress: Ref.Ref<StepProgress>,
	) => Effect.Effect<void, StateCaptureError>;
	/**
	 * Probes a state's `precondition` on the freshly loaded page.
	 *
	 * Succeeds with `true` when the selector became visible and `false` when it
	 * legitimately did not — that second answer is what makes a state `skipped`
	 * rather than `failed`. It *fails* when the precondition could not be
	 * evaluated at all: a malformed selector, a page that went away. Collapsing
	 * those two into `false` is what let a typo'd selector produce a green run
	 * with no capture, so they are different outcomes here.
	 */
	readonly checkPrecondition: (
		page: Page,
		stateName: string,
		selector: string,
		timeoutMs?: number,
	) => Effect.Effect<boolean, StateCaptureError>;
}

export interface ScriptedStateRunnerOptions {
	/** Action default when a step omits `timeoutMs`. */
	readonly defaultStepTimeoutMs?: number;
	/** Budget for the `precondition` probe; a state may override it. */
	readonly preconditionTimeoutMs?: number;
	/**
	 * The authoritative origin gate for `request` steps, applied to the URL each
	 * step resolves to from the *live* page URL.
	 *
	 * `validateStates` checks request origins before Chromium launches too, but
	 * against the state's configured URL; a script that navigates first resolves
	 * its paths against an origin that pass never saw. Left unset, the runner
	 * falls back to "same origin as the page", which is the property the `path`
	 * form is supposed to guarantee — fail closed, so a caller that forgets to
	 * pass a gate gets the narrow one rather than none.
	 */
	readonly isAllowedRequestUrl?: (url: URL) => boolean;
}

/**
 * A Playwright timeout, as distinct from a selector that could not be
 * evaluated at all.
 *
 * Matched by name rather than by `instanceof errors.TimeoutError`: a duplicate
 * playwright copy in the module graph makes class identity unreliable, and the
 * message test catches a timeout re-wrapped on its way out. A malformed
 * selector rejects with a plain `Error` ("Unexpected token ... while parsing
 * css selector"), so the two never collide.
 */
const isTimeoutFailure = (error: unknown): boolean =>
	error instanceof Error &&
	(error.name === "TimeoutError" || /\btimeout\b/i.test(error.message));

const errorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		const [first] = error.message.split("\n");
		return first?.trim() || error.message;
	}
	return String(error);
};

/**
 * Counts matches in the requested DOM state, from Node — `locator.count()` and
 * `locator.isVisible()`, never an injected predicate.
 *
 * `deadline` is the step's own, checked between elements: a selector matching
 * thousands of nodes takes one round trip each, and a pass that began inside
 * the budget must not run on past it merely because it started in time.
 */
const countMatching = async (
	locator: Locator,
	state: CountableState,
	deadline: number,
): Promise<number> => {
	const total = await locator.count();
	if (state === "attached") return total;
	let matched = 0;
	for (let i = 0; i < total; i++) {
		if (Date.now() >= deadline) {
			throw new Error(
				`the step deadline passed while inspecting matches: ${i} of ${total} checked, ${matched} matched so far`,
			);
		}
		if (await locator.nth(i).isVisible()) matched += 1;
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
	const { defaultStepTimeoutMs, preconditionTimeoutMs, isAllowedRequestUrl } =
		options;

	/**
	 * The gate `planStep` applies to a `request` before it becomes a plan.
	 *
	 * Fails closed: with no configured gate the only origin allowed is the one
	 * the page is actually on, and a page URL that will not parse allows none.
	 */
	const requestUrlGate = (pageUrl: string): ((url: URL) => boolean) => {
		if (isAllowedRequestUrl !== undefined) return isAllowedRequestUrl;
		let pageOrigin: string;
		try {
			pageOrigin = new URL(pageUrl).origin;
		} catch {
			return () => false;
		}
		return (url) => url.origin === pageOrigin;
	};

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
						// A pass is only ever *started* inside the budget, so the
						// count this reports is the last one taken while the step was
						// still entitled to run — not a degraded final pass.
						do {
							found = await countMatching(locator, plan.state, deadline);
							if (found >= plan.minCount) return;
							if (Date.now() >= deadline) break;
							await page.waitForTimeout(plan.pollMs);
						} while (Date.now() < deadline);
						throw new Error(
							`expected >=${plan.minCount} matching "${plan.state}", found ${found} after ${plan.timeoutMs}ms`,
						);
					},
					catch: (error) => fail(errorMessage(error), error),
				}).pipe(
					// The loop's own deadline governs; this only catches a page call
					// that never settles, which no in-loop check can reach.
					Effect.timeoutFail({
						duration: plan.timeoutMs + COUNT_BACKSTOP_GRACE_MS,
						onTimeout: () =>
							fail(
								`a page call made while counting matches never settled; abandoned after ${plan.timeoutMs + COUNT_BACKSTOP_GRACE_MS}ms`,
								null,
							),
					}),
				);

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

			case "press": {
				// Destructured so the untargeted path is visibly the one that has no
				// timeout to apply, rather than one that silently drops a computed
				// one — `planStep` carries `undefined` there for the same reason.
				const { selector, timeoutMs } = plan;
				return Effect.tryPromise({
					try: () =>
						selector === undefined
							? page.keyboard.press(plan.key)
							: page
									.locator(selector)
									.first()
									.press(plan.key, { timeout: timeoutMs }),
					catch: (error) => fail(errorMessage(error), error),
				});
			}

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
					const pageUrl = page.url();
					planned = planStep(step, {
						pageUrl,
						defaultTimeoutMs: defaultStepTimeoutMs,
						isAllowedRequestUrl: requestUrlGate(pageUrl),
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
					phase: "step",
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
					// The step succeeded; a budget that expires in here expired while
					// settling, not inside a step that is still running.
					yield* Ref.set(progress, {
						index,
						kind: planned.kind,
						target: planned.target,
						phase: "settle",
					});
					yield* Effect.sleep(planned.settleMs);
				}
			}

			// Past the last step the caller is no longer inside the script, so the
			// last step's name must stop standing in for "what is running now".
			yield* Ref.update(progress, (at) => ({ ...at, phase: "done" as const }));
		});

	const checkPrecondition = (
		page: Page,
		stateName: string,
		selector: string,
		timeoutMs?: number,
	): Effect.Effect<boolean, StateCaptureError> =>
		Effect.tryPromise({
			try: async (): Promise<boolean> => {
				const locator = page.locator(selector);
				// Evaluating the selector once before waiting on it is what keeps
				// the two answers apart. A malformed selector rejects here whether
				// or not the element exists; a valid selector that matches nothing
				// yet counts zero and falls through to the wait below, which is the
				// case that legitimately means "not present here".
				await locator.count();
				try {
					await locator.first().waitFor({
						state: "visible",
						timeout:
							timeoutMs ??
							preconditionTimeoutMs ??
							DEFAULT_PRECONDITION_TIMEOUT_MS,
					});
				} catch (error) {
					if (isTimeoutFailure(error)) return false;
					throw error;
				}
				return true;
			},
			catch: (error) =>
				new StateCaptureError({
					state: stateName,
					stepIndex: -1,
					stepKind: "precondition",
					target: selector,
					message: `state "${stateName}" could not evaluate its precondition "${selector}": ${errorMessage(error)}`,
					cause: error,
				}),
		});

	return { runStateScript, checkPrecondition } as const;
};
