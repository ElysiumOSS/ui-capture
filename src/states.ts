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
 * Parsing, chain resolution and pre-launch validation for scripted states.
 *
 * Everything here is pure: no filesystem, no Playwright. Authoring mistakes —
 * a duplicate name, a typo'd `extends`, an off-host `request` — are static
 * errors that abort the run before Chromium launches, because no amount of
 * retrying makes them resolve. Runtime failures are the opposite: recorded per
 * state, run continues. That split is the whole failure model.
 *
 * The `request` origin check here is an early abort, not the boundary. A
 * request path resolves against the *live* page URL at the moment the step
 * runs, and a script that navigates first moves that base out from under this
 * pass, which only ever sees the state's configured URL. The gate that decides
 * is the one `planStep` applies at runtime; see `state-plan.ts`.
 */

import { ArrayFormatter, ParseResult, Schema as S } from "@effect/schema";
import { Effect } from "effect";
import { StateDefinitionError } from "./errors.js";
import { CaptureState, type CaptureStep, StatesFile } from "./schemas.js";
import { isAllowedOrigin } from "./shared.js";
import {
	describeStep,
	resolveRequestUrl,
	StepPlanError,
	stepShapeError,
} from "./state-plan.js";

/** How deep an `extends` chain may go before it stops being reviewable. */
export const MAX_STATE_CHAIN_DEPTH = 5;

/** A state with its `extends` chain flattened into one step list. */
export interface ResolvedState {
	readonly state: CaptureState;
	/** The parent chain's steps, in order, followed by this state's own. */
	readonly steps: readonly CaptureStep[];
	/** The state's own `url`, or the nearest ancestor's. */
	readonly url: string | undefined;
	/**
	 * Set by this state or by any ancestor.
	 *
	 * The video suppression it opts out of is triggered by the *resolved* step
	 * list, so a child that inherits a parent's `request` step inherits the
	 * suppression; inheriting the opt-out alongside it is what keeps the pair
	 * from disagreeing. `extends` inherits exactly three things — steps, `url`
	 * and this flag; `precondition`, `viewports` and `timeoutMs` describe the
	 * child's own capture and stay per-state.
	 */
	readonly allowVideoReplay: boolean;
}

const decodeStatesFile = S.decodeUnknownEither(StatesFile);

/**
 * Decodes a states file's contents. Throws a plain `Error` carrying the Effect
 * Schema issue paths, matching how `parseViewports` reports a bad spec.
 */
export const parseStatesFile = (
	contents: string,
	sourcePath: string,
): ReadonlyArray<CaptureState> => {
	let raw: unknown;
	try {
		raw = JSON.parse(contents);
	} catch (error) {
		throw new Error(
			`${sourcePath} is not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	const decoded = decodeStatesFile(raw);
	if (decoded._tag === "Right") return decoded.right.states;

	const issues = ParseResult.isParseError(decoded.left)
		? ArrayFormatter.formatErrorSync(decoded.left)
		: [];
	const detail =
		issues.length > 0
			? issues
					.map(
						(issue) =>
							`  ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
					)
					.join("\n")
			: String(decoded.left);
	throw new Error(`Invalid states file ${sourcePath}:\n${detail}`);
};

/** True when any state's own steps include a `request`. */
export const statesUseRequests = (
	states: ReadonlyArray<CaptureState>,
): boolean =>
	states.some((state) => state.steps.some((step) => step.kind === "request"));

const definitionError = (
	state: string,
	message: string,
): StateDefinitionError =>
	new StateDefinitionError({ state, message, cause: null });

/**
 * Flattens every state's `extends` chain.
 *
 * `extends` is script composition, not page-state carryover: the child still
 * starts from a fresh load in a fresh context and replays the parent's steps.
 * Replay costs wall clock and buys the thing that matters — any state runs on
 * any worker, in any order, with no cross-task coupling.
 *
 * Three things flow down a chain: the steps, `url`, and `allowVideoReplay`.
 * Everything else (`precondition`, `viewports`, `timeoutMs`) describes the
 * child's own capture rather than the script it replays.
 *
 * Throws {@link StateDefinitionError} on an unknown parent, a cycle, or a
 * chain deeper than {@link MAX_STATE_CHAIN_DEPTH}.
 */
export const resolveStateSteps = (
	states: ReadonlyArray<CaptureState>,
): ReadonlyMap<string, ResolvedState> => {
	const byName = new Map<string, CaptureState>();
	for (const state of states) {
		if (byName.has(state.name)) {
			throw definitionError(
				state.name,
				`duplicate state name "${state.name}"; names become directories and must be unique`,
			);
		}
		byName.set(state.name, state);
	}

	const resolved = new Map<string, ResolvedState>();
	// Depth is tracked separately from the visit chain because resolution order
	// is file order: a parent resolved on its own line would otherwise seed the
	// cache and let an over-long chain through unnoticed.
	const depths = new Map<string, number>();

	const resolve = (
		state: CaptureState,
		chain: readonly string[],
	): ResolvedState => {
		const cached = resolved.get(state.name);
		if (cached) return cached;

		if (chain.includes(state.name)) {
			throw definitionError(
				state.name,
				`extends cycle: ${[...chain, state.name].join(" -> ")}`,
			);
		}

		let inherited: ResolvedState | undefined;
		let depth = 0;
		if (state.extends !== undefined) {
			const parent = byName.get(state.extends);
			if (!parent) {
				throw definitionError(
					state.name,
					`extends unknown state "${state.extends}"`,
				);
			}
			inherited = resolve(parent, [...chain, state.name]);
			depth = (depths.get(parent.name) ?? 0) + 1;
			if (depth > MAX_STATE_CHAIN_DEPTH) {
				throw definitionError(
					state.name,
					`extends chain is ${depth} links deep; the limit is ${MAX_STATE_CHAIN_DEPTH}`,
				);
			}
		}
		depths.set(state.name, depth);

		const value: ResolvedState = {
			state,
			steps: [...(inherited?.steps ?? []), ...state.steps],
			url: state.url ?? inherited?.url,
			allowVideoReplay:
				state.allowVideoReplay || (inherited?.allowVideoReplay ?? false),
		};
		resolved.set(state.name, value);
		return value;
	};

	for (const state of states) resolve(state, []);
	return resolved;
};

export interface ValidateStatesOptions {
	readonly states: ReadonlyArray<CaptureState>;
	readonly seedUrl: string;
	readonly hostMatchesFilters: (hostname: string) => boolean;
	readonly allowStateRequests: boolean;
	readonly viewportNames: ReadonlyArray<string>;
	readonly captureRoutes: boolean;
}

/**
 * Every check that can be made before the browser launches.
 *
 * A failure here aborts the run, so the user fixes their file once instead of
 * watching a full crawl produce four identical timeouts.
 */
export const validateStates = (
	options: ValidateStatesOptions,
): Effect.Effect<ReadonlyMap<string, ResolvedState>, StateDefinitionError> =>
	Effect.suspend(() => {
		const {
			states,
			seedUrl,
			hostMatchesFilters,
			allowStateRequests,
			viewportNames,
			captureRoutes,
		} = options;

		if (states.length === 0) {
			return captureRoutes
				? Effect.succeed(new Map<string, ResolvedState>())
				: Effect.fail(
						definitionError(
							"(run)",
							"nothing to capture: route capture is disabled and no scripted states were supplied",
						),
					);
		}

		let resolved: ReadonlyMap<string, ResolvedState>;
		try {
			resolved = resolveStateSteps(states);
		} catch (error) {
			return error instanceof StateDefinitionError
				? Effect.fail(error)
				: Effect.fail(
						new StateDefinitionError({
							state: "(states)",
							message: error instanceof Error ? error.message : String(error),
							cause: error,
						}),
					);
		}

		const viewportSet = new Set(viewportNames);

		// Parsed once, and up front: it is the origin every state URL and every
		// `request` path is measured against, so an unusable seed is a definition
		// error rather than a defect thrown from inside the loop.
		let seed: URL;
		try {
			seed = new URL(seedUrl);
		} catch {
			return Effect.fail(
				definitionError(
					"(run)",
					`seed url "${seedUrl}" is not an absolute URL, so state urls have nothing to resolve against`,
				),
			);
		}

		for (const entry of resolved.values()) {
			const { state } = entry;

			let stateUrl: URL;
			try {
				stateUrl = new URL(entry.url ?? seedUrl, seedUrl);
			} catch {
				return Effect.fail(
					definitionError(
						state.name,
						`url "${String(entry.url)}" does not resolve against "${seedUrl}"`,
					),
				);
			}
			if (!isAllowedOrigin(stateUrl, seed, hostMatchesFilters)) {
				return Effect.fail(
					definitionError(
						state.name,
						`url "${stateUrl.toString()}" is outside the allowed origins: an origin is scheme + host + port, and the seed's is "${seed.origin}"`,
					),
				);
			}

			if (state.viewports) {
				const unknownViewport = state.viewports.find(
					(name) => !viewportSet.has(name),
				);
				if (unknownViewport !== undefined) {
					return Effect.fail(
						definitionError(
							state.name,
							`viewports names "${unknownViewport}", which is not a configured viewport (${viewportNames.join(", ")})`,
						),
					);
				}
			}

			for (const [index, step] of entry.steps.entries()) {
				// Fields that contradict each other — a `minCount` on a state no
				// count can express, a `timeoutMs` on a press with nothing to wait
				// for. `planStep` rejects these again at runtime; catching them here
				// is what turns them into a fixable authoring error rather than a
				// failed state per viewport.
				const shapeError = stepShapeError(step);
				if (shapeError !== undefined) {
					return Effect.fail(
						definitionError(
							state.name,
							`step ${index} (${describeStep(step)}): ${shapeError}`,
						),
					);
				}

				if (step.kind !== "request") continue;
				if (!allowStateRequests) {
					return Effect.fail(
						definitionError(
							state.name,
							`step ${index} (request ${step.method} ${step.path}) needs --allow-state-requests (allowStateRequests: true); request steps reach past the UI into the backend, so they are opt-in`,
						),
					);
				}
				let requestUrl: URL;
				try {
					requestUrl = resolveRequestUrl(step.path, stateUrl.toString());
				} catch (error) {
					return Effect.fail(
						definitionError(
							state.name,
							`step ${index} (request ${step.method} ${step.path}): ${
								error instanceof StepPlanError ? error.message : String(error)
							}`,
						),
					);
				}
				if (!isAllowedOrigin(requestUrl, seed, hostMatchesFilters)) {
					return Effect.fail(
						definitionError(
							state.name,
							`step ${index} (request ${step.method} ${step.path}) resolves to "${requestUrl.toString()}", which is outside the allowed origins: an origin is scheme + host + port, and the seed's is "${seed.origin}"`,
						),
					);
				}
			}
		}

		return Effect.succeed(resolved);
	});

/**
 * Rewrites a resolved state as a self-contained one: the chain's steps inlined
 * in order, the inherited `url` and `allowVideoReplay` made explicit, and
 * `extends` dropped so nothing downstream needs the ancestor to still be in
 * the list.
 *
 * Everything {@link resolveStateSteps} inherits has to be written back here,
 * not just the steps. `allowVideoReplay` is the one that bites: the `request`
 * step which suppresses video is inherited, so a child that carried the step
 * but not the parent's opt-out would record video on an unfiltered run and
 * silently drop it under `--state-filter`: one file, two different results.
 *
 * Spread-then-override rather than a field-by-field copy, so a field added to
 * {@link CaptureState} later is carried instead of silently lost here.
 */
const flattenChain = (entry: ResolvedState): CaptureState => {
	const { state } = entry;
	if (state.extends === undefined) return state;
	const { extends: _inherited, ...own } = state;
	return new CaptureState({
		...own,
		steps: [...entry.steps],
		allowVideoReplay: entry.allowVideoReplay,
		...(entry.url !== undefined ? { url: entry.url } : {}),
	});
};

/**
 * Narrows a states list to the named states, and to those only.
 *
 * An ancestor reached through `extends` is *resolution* input, not a capture
 * target. Returning it alongside the named states — which is what a flat
 * "keep the ancestors too" list does — captures states the user did not name
 * and re-runs their side-effecting steps, a `request` seed among them, which
 * is the opposite of what a filter means. So the chain is resolved here and
 * folded into each named state instead: the returned states carry everything
 * the chain contributes — the ancestors' steps, the inherited `url` and the
 * inherited `allowVideoReplay` — and carry no `extends`, so a filtered run
 * captures each named state exactly as an unfiltered one does.
 *
 * Throws when a name matches nothing, because silently running zero states is
 * the coverage lie again, and propagates {@link StateDefinitionError} from
 * chain resolution — a filtered run has to resolve before it can be flattened.
 */
export const filterStates = (
	states: ReadonlyArray<CaptureState>,
	names: ReadonlyArray<string>,
): ReadonlyArray<CaptureState> => {
	const byName = new Map(states.map((state) => [state.name, state]));
	const unknown = names.filter((name) => !byName.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown state name(s): ${unknown.join(", ")}. Available: ${
				states.map((state) => state.name).join(", ") || "(none)"
			}`,
		);
	}

	// Resolution runs over the *whole* file: the ancestors have to be reachable
	// to be folded in, even though none of them is being captured.
	const resolved = resolveStateSteps(states);
	const selected = new Set(names);

	// File order, deduplicated: a name repeated in --state-filter must not
	// capture the same directory twice.
	return states
		.filter((state) => selected.has(state.name))
		.map((state) => {
			const entry = resolved.get(state.name);
			return entry === undefined ? state : flattenChain(entry);
		});
};
