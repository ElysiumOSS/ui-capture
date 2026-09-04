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
 * What a step *means*, decided without a browser.
 *
 * This module is deliberately free of Playwright: it turns a declarative
 * {@link CaptureStep} into a {@link StepPlan}, which is still plain data.
 * `state-script.ts` is the only place that drives a `Page`, so the whole
 * vocabulary — defaults, timeout precedence, URL resolution, the human-facing
 * labels in failure messages — is testable without launching Chromium.
 *
 * It is also where the two gates that *decide* rather than describe live, and
 * they live here for the same reason: {@link stepShapeError} rejects a step
 * whose fields contradict each other, and the `request` host check in
 * {@link planStep} runs against the URL the step actually resolves to. Both are
 * mirrored by pre-launch checks in `states.ts` so an authoring mistake aborts
 * before Chromium launches, but the copies here are the authoritative ones:
 * a plan is never built without them, whatever the caller did or did not
 * validate first. Both gates run the same comparison the pre-launch pass does
 * — `isAllowedOrigin` for a request — so neither can be wider than the other.
 */

import type { CaptureStep } from "./schemas.js";

/** Action default when a step does not set `timeoutMs`. */
export const DEFAULT_STEP_TIMEOUT_MS = 5000;

/** How often `waitFor` with `minCount` re-counts matches. */
export const COUNT_POLL_INTERVAL_MS = 100;

export type ElementState = "visible" | "hidden" | "attached" | "detached";

/**
 * The DOM states a `minCount` wait can count.
 *
 * `minCount` is a minimum over *matched elements*, so it only means something
 * for a state an element can be matched in. `hidden` and `detached` both treat
 * "there is no such element at all" as a pass on the selector path, which no
 * minimum count can express — counting would silently redefine them. Those
 * combinations are rejected by {@link stepShapeError} instead.
 */
export type CountableState = Extract<ElementState, "visible" | "attached">;

/** Narrows an {@link ElementState} to one `minCount` can count. */
export const isCountableState = (
	state: ElementState,
): state is CountableState => state === "visible" || state === "attached";

export type StepPlan =
	| {
			readonly op: "waitForSelector";
			readonly selector: string;
			readonly state: ElementState;
			readonly timeoutMs: number;
	  }
	| {
			readonly op: "waitForCount";
			readonly selector: string;
			readonly minCount: number;
			readonly state: CountableState;
			readonly timeoutMs: number;
			readonly pollMs: number;
	  }
	| { readonly op: "sleep"; readonly ms: number }
	| {
			readonly op: "click";
			readonly selector: string;
			readonly nth: number;
			readonly timeoutMs: number;
	  }
	| {
			readonly op: "fill";
			readonly selector: string;
			readonly value: string;
			readonly timeoutMs: number;
	  }
	| {
			readonly op: "select";
			readonly selector: string;
			readonly values: readonly string[];
			readonly timeoutMs: number;
	  }
	| {
			readonly op: "press";
			readonly key: string;
			readonly selector: string | undefined;
			/**
			 * Only the targeted path takes one. Without a `selector` the key goes
			 * to `page.keyboard`, which has no element to wait for and accepts no
			 * timeout, so the plan carries none rather than one the driver would
			 * quietly drop.
			 */
			readonly timeoutMs: number | undefined;
	  }
	| {
			readonly op: "request";
			readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
			readonly url: string;
			readonly json: unknown;
			readonly hasJson: boolean;
			readonly headers: Record<string, string>;
			readonly expectStatus: number | undefined;
			readonly timeoutMs: number;
	  }
	| {
			readonly op: "reload";
			readonly waitUntil:
				| "load"
				| "domcontentloaded"
				| "networkidle"
				| "commit";
			readonly timeoutMs: number;
	  };

export interface PlannedStep {
	readonly plan: StepPlan;
	/** Pause after the step succeeds. */
	readonly settleMs: number;
	/** Log and continue instead of failing the state. */
	readonly optional: boolean;
	/** Step kind, carried into {@link StateCaptureError}. */
	readonly kind: CaptureStep["kind"];
	/** The selector, key, path or duration the step acts on. */
	readonly target: string;
	/** `click "#spawn"` — used verbatim in logs and failure messages. */
	readonly label: string;
}

export interface PlanContext {
	/** The page's current URL; `request` paths resolve against it. */
	readonly pageUrl: string;
	/** Action default when a step omits `timeoutMs`. */
	readonly defaultTimeoutMs?: number;
	/**
	 * The authoritative origin gate for `request` steps.
	 *
	 * `validateStates` also checks request origins before Chromium launches, but
	 * against the state's *configured* URL, while a path resolves at runtime
	 * against the live {@link pageUrl} — a script that clicks through to another
	 * origin first resolves against one the pre-launch pass never saw. The gate
	 * therefore has to be applied where the resolution happens, which is here;
	 * the pre-launch check is a convenience that fails the run early.
	 *
	 * The predicate takes the resolved URL rather than its hostname so both
	 * gates can be the same `isAllowedOrigin` comparison — scheme, host and
	 * port — and a states file that validated cannot be widened at runtime.
	 *
	 * Omitted, no gate is applied: planning is a pure function, and a caller
	 * that plans without driving a page is not making a request. The driver
	 * never omits it — see `createScriptedStateRunner`, which falls back to a
	 * same-origin-as-the-page gate when its own option is unset.
	 */
	readonly isAllowedRequestUrl?: (url: URL) => boolean;
}

/**
 * Thrown for a step that cannot be turned into a plan at all — today, only a
 * `request` path that will not resolve into a URL. Callers map it onto a
 * `StateDefinitionError` (pre-launch) or a `StateCaptureError` (at runtime).
 */
export class StepPlanError extends Error {
	readonly kind: CaptureStep["kind"];
	readonly target: string;

	constructor(kind: CaptureStep["kind"], target: string, message: string) {
		super(message);
		this.name = "StepPlanError";
		this.kind = kind;
		this.target = target;
	}
}

/**
 * The value a failure message quotes for each step kind.
 *
 * Internal: callers outside this module want {@link describeStep}, which is
 * the whole human-facing label, or `PlannedStep.target`, which is this value
 * already attached to the step it belongs to.
 */
const stepTarget = (step: CaptureStep): string => {
	switch (step.kind) {
		case "waitFor":
		case "click":
		case "fill":
		case "select":
			return step.selector;
		case "wait":
			return `${step.ms}ms`;
		case "press":
			return step.selector ? `${step.key} @ ${step.selector}` : step.key;
		case "request":
			return `${step.method} ${step.path}`;
		case "reload":
			return step.waitUntil;
	}
};

/** `click "#spawn"` / `request POST /api/sim/seed`. */
export const describeStep = (step: CaptureStep): string =>
	step.kind === "request" || step.kind === "wait" || step.kind === "reload"
		? `${step.kind} ${stepTarget(step)}`
		: `${step.kind} "${stepTarget(step)}"`;

/**
 * Resolves a `request` path against the page URL.
 *
 * A path is same-origin by construction, which removes a whole class of
 * misconfiguration before validation has to catch it; an absolute URL is
 * still accepted so a states file can be explicit, and is then subjected to
 * the crawler's host filter by the caller.
 */
export const resolveRequestUrl = (
	requestPath: string,
	pageUrl: string,
): URL => {
	let resolved: URL;
	try {
		resolved = new URL(requestPath, pageUrl);
	} catch {
		throw new StepPlanError(
			"request",
			requestPath,
			`cannot resolve "${requestPath}" against "${pageUrl}"`,
		);
	}
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
		throw new StepPlanError(
			"request",
			requestPath,
			`unsupported scheme "${resolved.protocol}" (http and https only)`,
		);
	}
	return resolved;
};

/**
 * Step shapes the schema admits but that cannot be carried out as written.
 *
 * The schema validates each field on its own; these are the combinations whose
 * fields contradict *each other*, and the alternative to rejecting them is
 * worse than a hard error — one field silently redefining another is how a
 * script comes to mean something its author never wrote.
 *
 * Returns the reason, or `undefined` when the step is expressible. One
 * function, two callers: `validateStates` runs it before Chromium launches so
 * an authoring mistake aborts the run, and {@link planStep} runs it on every
 * step it plans so no caller reaches the driver around it.
 */
export const stepShapeError = (step: CaptureStep): string | undefined => {
	if (
		step.kind === "waitFor" &&
		step.minCount !== undefined &&
		!isCountableState(step.state)
	) {
		return `minCount counts matching elements, but state "${step.state}" also passes when nothing matches at all, so a minimum over matches cannot express it; use state "visible" or "attached" with minCount, or drop minCount to wait for the first match to become ${step.state}`;
	}
	if (
		step.kind === "press" &&
		step.selector === undefined &&
		step.timeoutMs !== undefined
	) {
		return `timeoutMs has no effect on an untargeted press: with no selector the key goes to page.keyboard, which has no element to wait for; add a selector, or drop timeoutMs`;
	}
	return undefined;
};

/**
 * Turns one declarative step into the operation a driver performs, applying
 * the timeout precedence: step `timeoutMs`, then the action default.
 *
 * Throws {@link StepPlanError} for a step that cannot be planned: a shape
 * {@link stepShapeError} rejects, a `request` path that will not resolve, or a
 * `request` that resolves outside `ctx.isAllowedRequestUrl`.
 */
export const planStep = (step: CaptureStep, ctx: PlanContext): PlannedStep => {
	const shapeError = stepShapeError(step);
	if (shapeError !== undefined) {
		throw new StepPlanError(step.kind, stepTarget(step), shapeError);
	}

	const timeoutMs =
		step.timeoutMs ?? ctx.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const common = {
		settleMs: step.settleMs ?? 0,
		optional: step.optional,
		kind: step.kind,
		target: stepTarget(step),
		label: describeStep(step),
	} as const;

	switch (step.kind) {
		case "waitFor":
			return {
				...common,
				plan:
					// The state re-test is what proves to the type system that a
					// counting plan only ever carries a countable state; the throw
					// above has already rejected the alternative, and if it were ever
					// removed this degrades to the plain selector wait rather than
					// counting something `hidden` does not mean.
					step.minCount !== undefined && isCountableState(step.state)
						? {
								op: "waitForCount",
								selector: step.selector,
								minCount: step.minCount,
								state: step.state,
								timeoutMs,
								pollMs: COUNT_POLL_INTERVAL_MS,
							}
						: {
								op: "waitForSelector",
								selector: step.selector,
								state: step.state,
								timeoutMs,
							},
			};
		case "wait":
			return { ...common, plan: { op: "sleep", ms: step.ms } };
		case "click":
			return {
				...common,
				plan: {
					op: "click",
					selector: step.selector,
					nth: step.nth ?? 0,
					timeoutMs,
				},
			};
		case "fill":
			return {
				...common,
				plan: {
					op: "fill",
					selector: step.selector,
					value: step.value,
					timeoutMs,
				},
			};
		case "select":
			return {
				...common,
				plan: {
					op: "select",
					selector: step.selector,
					values: [...step.values],
					timeoutMs,
				},
			};
		case "press":
			return {
				...common,
				plan: {
					op: "press",
					key: step.key,
					selector: step.selector,
					// An untargeted press carries no timeout at all, rather than one
					// the driver would compute and then silently drop; an explicit
					// one on that shape was rejected by stepShapeError above.
					timeoutMs: step.selector === undefined ? undefined : timeoutMs,
				},
			};
		case "request": {
			const url = resolveRequestUrl(step.path, ctx.pageUrl);
			if (
				ctx.isAllowedRequestUrl !== undefined &&
				!ctx.isAllowedRequestUrl(url)
			) {
				throw new StepPlanError(
					"request",
					stepTarget(step),
					`resolves to "${url.toString()}" against the page URL "${ctx.pageUrl}", which is outside the allowed origins: an origin is scheme + host + port`,
				);
			}
			return {
				...common,
				plan: {
					op: "request",
					method: step.method,
					url: url.toString(),
					json: step.json,
					hasJson: step.json !== undefined,
					headers: { ...(step.headers ?? {}) },
					expectStatus: step.expectStatus,
					timeoutMs,
				},
			};
		}
		case "reload":
			return {
				...common,
				plan: { op: "reload", waitUntil: step.waitUntil, timeoutMs },
			};
	}
};

/** True when a response satisfies the step's expectation. */
export const isExpectedStatus = (
	status: number,
	expectStatus: number | undefined,
): boolean =>
	expectStatus === undefined
		? status >= 200 && status < 300
		: status === expectStatus;
