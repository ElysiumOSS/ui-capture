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
 */

import { ArrayFormatter, ParseResult, Schema as S } from "@effect/schema";
import { Effect } from "effect";
import { StateDefinitionError } from "./errors.js";
import { type CaptureState, type CaptureStep, StatesFile } from "./schemas.js";
import { resolveRequestUrl, StepPlanError } from "./state-plan.js";

/** How deep an `extends` chain may go before it stops being reviewable. */
export const MAX_STATE_CHAIN_DEPTH = 5;

/** A state with its `extends` chain flattened into one step list. */
export interface ResolvedState {
	readonly state: CaptureState;
	/** The parent chain's steps, in order, followed by this state's own. */
	readonly steps: readonly CaptureStep[];
	/** The state's own `url`, or the nearest ancestor's. */
	readonly url: string | undefined;
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
			if (!hostMatchesFilters(stateUrl.hostname)) {
				return Effect.fail(
					definitionError(
						state.name,
						`url "${stateUrl.toString()}" is outside the allowed hosts`,
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
				if (!hostMatchesFilters(requestUrl.hostname)) {
					return Effect.fail(
						definitionError(
							state.name,
							`step ${index} (request ${step.method} ${step.path}) resolves to "${requestUrl.toString()}", which is outside the allowed hosts`,
						),
					);
				}
			}
		}

		return Effect.succeed(resolved);
	});

/**
 * Narrows a states list to the named states, keeping every ancestor they
 * `extends` so a filtered run still resolves. Throws when a name matches
 * nothing, because silently running zero states is the coverage lie again.
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

	const keep = new Set<string>();
	const visit = (name: string, seen: ReadonlySet<string>): void => {
		if (keep.has(name) || seen.has(name)) return;
		const state = byName.get(name);
		if (!state) return;
		keep.add(name);
		if (state.extends !== undefined) {
			visit(state.extends, new Set([...seen, name]));
		}
	};
	for (const name of names) visit(name, new Set());

	return states.filter((state) => keep.has(state.name));
};
