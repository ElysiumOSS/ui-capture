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
 */

import type { CaptureStep } from "./schemas.js";

/** Action default when a step does not set `timeoutMs`. */
export const DEFAULT_STEP_TIMEOUT_MS = 5000;

/** How often `waitFor` with `minCount` re-counts matches. */
export const COUNT_POLL_INTERVAL_MS = 100;

export type ElementState = "visible" | "hidden" | "attached" | "detached";

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
			readonly state: ElementState;
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
			readonly timeoutMs: number;
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

/** The value a failure message quotes for each step kind. */
export const stepTarget = (step: CaptureStep): string => {
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
 * Turns one declarative step into the operation a driver performs, applying
 * the timeout precedence: step `timeoutMs`, then the action default.
 */
export const planStep = (step: CaptureStep, ctx: PlanContext): PlannedStep => {
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
					step.minCount === undefined
						? {
								op: "waitForSelector",
								selector: step.selector,
								state: step.state,
								timeoutMs,
							}
						: {
								op: "waitForCount",
								selector: step.selector,
								minCount: step.minCount,
								state: step.state,
								timeoutMs,
								pollMs: COUNT_POLL_INTERVAL_MS,
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
					timeoutMs,
				},
			};
		case "request":
			return {
				...common,
				plan: {
					op: "request",
					method: step.method,
					url: resolveRequestUrl(step.path, ctx.pageUrl).toString(),
					json: step.json,
					hasJson: step.json !== undefined,
					headers: { ...(step.headers ?? {}) },
					expectStatus: step.expectStatus,
					timeoutMs,
				},
			};
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
