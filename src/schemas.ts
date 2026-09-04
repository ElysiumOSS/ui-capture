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
import { Schema as S } from "@effect/schema";

export class ViewportConfig extends S.Class<ViewportConfig>("ViewportConfig")({
	name: S.String,
	width: S.Number.pipe(S.int(), S.positive()),
	height: S.Number.pipe(S.int(), S.positive()),
}) {}

export class ScreenshotPaths extends S.Class<ScreenshotPaths>(
	"ScreenshotPaths",
)({
	png: S.String,
	webp: S.String,
	jpg: S.String,
}) {}

export class VideoQualityPaths extends S.Class<VideoQualityPaths>(
	"VideoQualityPaths",
)({
	high: S.String,
	medium: S.String,
	low: S.String,
}) {}

/**
 * Modifiers every scripted step carries.
 *
 * `settleMs` attaches the pause to the action that caused it, which is what
 * keeps a script readable: `{"kind":"click","settleMs":400}` says *why* the
 * pause exists, where a bare {@link WaitStep} two lines down does not.
 */
const StepBaseFields = {
	/** Log and skip this step on failure instead of failing the whole state. */
	optional: S.optionalWith(S.Boolean, { default: () => false }),
	/** Per-step timeout override (default: 5000). */
	timeoutMs: S.optional(S.Number.pipe(S.int(), S.positive())),
	/** Pause after the step succeeds, for animation/transition settling. */
	settleMs: S.optional(S.Number.pipe(S.int(), S.nonNegative())),
};

/**
 * Wait for a selector to reach a DOM state. This is also the assertion
 * mechanism: if the dialog never opens, the state fails rather than
 * screenshotting the boot view and reporting success.
 */
export class WaitForStep extends S.Class<WaitForStep>("WaitForStep")({
	kind: S.Literal("waitFor"),
	selector: S.String,
	state: S.optionalWith(
		S.Literal("visible", "hidden", "attached", "detached"),
		{ default: () => "visible" as const },
	),
	/**
	 * Require at least this many matches. Waiting for *one* `.fleet-row` and
	 * shooting a half-populated fleet is exactly the "looks like coverage"
	 * failure scripted states exist to eliminate.
	 */
	minCount: S.optional(S.Number.pipe(S.int(), S.positive())),
	...StepBaseFields,
}) {}

/**
 * A blind pause. The only honest tool for a WebGL scene whose intro tween has
 * no DOM correlate; prefer `settleMs` on the action that caused the wait, or
 * {@link WaitForStep} on a readiness attribute, whenever one exists.
 */
export class WaitStep extends S.Class<WaitStep>("WaitStep")({
	kind: S.Literal("wait"),
	ms: S.Number.pipe(S.int(), S.nonNegative()),
	...StepBaseFields,
}) {}

export class ClickStep extends S.Class<ClickStep>("ClickStep")({
	kind: S.Literal("click"),
	selector: S.String,
	/** Zero-based index when the selector matches several elements. */
	nth: S.optional(S.Number.pipe(S.int(), S.nonNegative())),
	...StepBaseFields,
}) {}

export class FillStep extends S.Class<FillStep>("FillStep")({
	kind: S.Literal("fill"),
	selector: S.String,
	value: S.String,
	...StepBaseFields,
}) {}

/**
 * Drive a native `<select>`. Not redundant with {@link ClickStep}: Chromium
 * renders the option list in an OS-level popup that DOM clicks cannot reach.
 */
export class SelectStep extends S.Class<SelectStep>("SelectStep")({
	kind: S.Literal("select"),
	selector: S.String,
	values: S.Array(S.String),
	...StepBaseFields,
}) {}

export class PressStep extends S.Class<PressStep>("PressStep")({
	kind: S.Literal("press"),
	key: S.String,
	/** Target a specific element; omitted, the key goes to `page.keyboard`. */
	selector: S.optional(S.String),
	...StepBaseFields,
}) {}

/**
 * Seed application state through the app's own API, using the page's browser
 * context so the request inherits its session cookie and origin.
 *
 * `path` is resolved against the page URL, making it same-origin by
 * construction; the crawler's host filter is applied as a second gate. Runs
 * only when `allowStateRequests` is enabled (`--allow-state-requests`).
 */
export class RequestStep extends S.Class<RequestStep>("RequestStep")({
	kind: S.Literal("request"),
	method: S.Literal("GET", "POST", "PUT", "PATCH", "DELETE"),
	/** Resolved against the page URL. Absolute URLs must stay same-host. */
	path: S.String,
	json: S.optional(S.Unknown),
	headers: S.optional(S.Record({ key: S.String, value: S.String })),
	/** Defaults to "any 2xx". A seed that silently 500s fails the state. */
	expectStatus: S.optional(S.Number.pipe(S.int(), S.positive())),
	...StepBaseFields,
}) {}

/**
 * Re-enter the app against new server state. Without it {@link RequestStep} is
 * half-useless: an app that reads its fleet once at boot never shows seeded
 * data on the already-loaded page.
 */
export class ReloadStep extends S.Class<ReloadStep>("ReloadStep")({
	kind: S.Literal("reload"),
	waitUntil: S.optionalWith(
		S.Literal("load", "domcontentloaded", "networkidle", "commit"),
		{ default: () => "networkidle" as const },
	),
	...StepBaseFields,
}) {}

/**
 * The complete scripted-step vocabulary.
 *
 * The governing rule for admitting a kind: a step must produce **committed
 * page state**, must be readable as data by a reviewer, and must not be
 * expressible by composing the others. That rule is why there is no `hover`
 * (cursor-transient, and the viewport loop resizes underneath it), no
 * `evaluate` (unreviewable), and no variables — no response value is ever
 * bound to a name, so there is no templating, interpolation, or expression
 * language anywhere in the format.
 */
export const CaptureStep = S.Union(
	WaitForStep,
	WaitStep,
	ClickStep,
	FillStep,
	SelectStep,
	PressStep,
	RequestStep,
	ReloadStep,
);
export type CaptureStep = typeof CaptureStep.Type;

/**
 * A named interaction script performed on a page before capture, so the state
 * it produces gets its own capture set.
 *
 * `name` is pattern-constrained because it becomes a directory component:
 * rejecting loudly beats silently slugifying two states into one directory,
 * and lowercase-only avoids `Spawn`/`spawn` colliding on a case-insensitive
 * filesystem.
 */
export class CaptureState extends S.Class<CaptureState>("CaptureState")({
	name: S.String.pipe(S.pattern(/^[a-z0-9][a-z0-9-]*$/)),
	description: S.optional(S.String),
	/** Absolute, or relative to the seed URL. Defaults to the seed URL. */
	url: S.optional(S.String),
	/**
	 * Prepend another state's steps to this one's. The child still starts from a
	 * fresh page load in a fresh context and *replays* the parent — states never
	 * inherit live page state from each other.
	 */
	extends: S.optional(S.String),
	/**
	 * A selector probed on the fresh load, before any step. When it is absent,
	 * the state is recorded as `skipped` rather than `failed`: "this state does
	 * not exist here" is a different event from "this state's script is broken".
	 */
	precondition: S.optional(S.String),
	/**
	 * Restrict this state to named viewports. The script runs once and the
	 * viewport loop resizes afterwards, so a dialog that unmounts below a
	 * breakpoint would otherwise be screenshotted as the boot view.
	 */
	viewports: S.optional(S.Array(S.String)),
	steps: S.Array(CaptureStep),
	/** Whole-state budget: navigation + script + capture. */
	timeoutMs: S.optional(S.Number.pipe(S.int(), S.positive())),
	/**
	 * Record video for this state even though its script contains a `request`
	 * step. Video replays the script in a second context, so a non-idempotent
	 * seed would run twice and the video would disagree with the stills; such
	 * states skip video unless this says otherwise.
	 */
	allowVideoReplay: S.optionalWith(S.Boolean, { default: () => false }),
}) {}

/**
 * The on-disk states file. `version` is required rather than defaulted: the
 * step vocabulary becomes a public JSON format on files on other people's
 * disks the day it ships, and a discriminant is what lets a v2 rename a kind
 * without guessing at an unversioned file's intent.
 */
export class StatesFile extends S.Class<StatesFile>("StatesFile")({
	version: S.Literal(1),
	states: S.Array(CaptureState),
}) {}

/** Outcome of one scripted state. */
export const StateStatus = S.Literal("captured", "skipped", "failed");
export type StateStatus = typeof StateStatus.Type;

export class CaptureResult extends S.Class<CaptureResult>("CaptureResult")({
	url: S.String,
	route: S.String,
	/** Set only for scripted-state captures; absent for crawled routes. */
	state: S.optional(S.String),
	stateStatus: S.optional(StateStatus),
	/** Index of the step that failed; `-1` for a whole-state failure. */
	failedStepIndex: S.optional(S.Number.pipe(S.int())),
	screenshots: S.Record({ key: S.String, value: ScreenshotPaths }),
	videos: S.optional(S.Record({ key: S.String, value: VideoQualityPaths })),
	error: S.optional(S.String),
	timestamp: S.Number.pipe(S.int()),
}) {}

const VideoOptionsFields = {
	duration: S.Number.pipe(S.int(), S.positive()),
	interactions: S.Boolean,
};

export class VideoOptions extends S.Class<VideoOptions>("VideoOptions")(
	VideoOptionsFields,
) {
	static readonly Default = new VideoOptions({
		duration: 10000,
		interactions: true,
	});
}

const CaptureConfigFields = {
	outputDir: S.String,
	captureVideo: S.Boolean,
	viewports: S.Array(ViewportConfig),
	maxDepth: S.Number.pipe(S.int(), S.nonNegative()),
	waitTime: S.Number.pipe(S.int(), S.nonNegative()),
	videoOptions: VideoOptions,
	includeSubdomains: S.Boolean,
	allowedHosts: S.Array(S.String),
	routeConcurrency: S.Number.pipe(S.int(), S.positive()),
	menuInteractionSelectors: S.Array(S.String),
	screenshotHideSelectors: S.Array(S.String),
	ffmpegPath: S.String,
	warmupScroll: S.Boolean,
	launchArgs: S.Array(S.String),
	/**
	 * The `prefers-color-scheme` the browser reports to the page.
	 *
	 * Defaults to `"light"`, matching Playwright, so existing captures are
	 * unchanged. Sites that follow the OS theme render their light face under
	 * headless Chromium regardless of what their authors see day to day, so
	 * capturing such a site's dark face requires saying so explicitly.
	 */
	colorScheme: S.Literal("light", "dark", "no-preference"),
	/**
	 * Named interaction scripts run before capture. Empty by default, so a run
	 * without a states file behaves exactly as it always has.
	 */
	states: S.Array(CaptureState),
	/** Default whole-state budget in ms; a state may override it. */
	stateTimeout: S.Number.pipe(S.int(), S.positive()),
	/** Crawl and capture routes. `false` captures only scripted states. */
	captureRoutes: S.Boolean,
	/**
	 * Permit `request` steps. Off by default: a states file handed to you by a
	 * colleague should not be able to POST to your app because you ran the tool.
	 */
	allowStateRequests: S.Boolean,
};

export class CaptureConfig extends S.Class<CaptureConfig>("CaptureConfig")(
	CaptureConfigFields,
) {
	static readonly Default = new CaptureConfig({
		outputDir: "ui-captures",
		captureVideo: false,
		viewports: [
			new ViewportConfig({ name: "desktop", width: 1920, height: 1080 }),
			new ViewportConfig({ name: "tablet", width: 768, height: 1024 }),
			new ViewportConfig({ name: "mobile", width: 375, height: 667 }),
		],
		maxDepth: 2,
		waitTime: 2000,
		videoOptions: VideoOptions.Default,
		includeSubdomains: false,
		allowedHosts: [],
		routeConcurrency: 2,
		menuInteractionSelectors: [],
		screenshotHideSelectors: [],
		ffmpegPath: "ffmpeg",
		warmupScroll: true,
		launchArgs: [],
		colorScheme: "light",
		states: [],
		stateTimeout: 30000,
		captureRoutes: true,
		allowStateRequests: false,
	});
}

export class CaptureReport extends S.Class<CaptureReport>("CaptureReport")({
	timestamp: S.String,
	/** Crawled routes only; scripted states are counted separately. */
	totalRoutes: S.Number.pipe(S.int(), S.nonNegative()),
	totalStates: S.Number.pipe(S.int(), S.nonNegative()),
	successfulCaptures: S.Number.pipe(S.int(), S.nonNegative()),
	failedCaptures: S.Number.pipe(S.int(), S.nonNegative()),
	/** States whose `precondition` was absent on the loaded page. */
	skippedStates: S.Number.pipe(S.int(), S.nonNegative()),
	viewports: S.Array(ViewportConfig),
	results: S.Array(
		S.Struct({
			url: S.String,
			route: S.String,
			state: S.optional(S.String),
			stateStatus: S.optional(StateStatus),
			failedStepIndex: S.optional(S.Number.pipe(S.int())),
			screenshots: S.Array(S.String),
			hasVideo: S.Boolean,
			error: S.optional(S.String),
		}),
	),
}) {}

type ViewportConfigInput =
	| ViewportConfig
	| {
			readonly name: string;
			readonly width: number;
			readonly height: number;
	  };

type VideoOptionsInput =
	| VideoOptions
	| {
			readonly duration?: number;
			readonly interactions?: boolean;
	  };

/**
 * A {@link CaptureState}, or the plain object shape a states file decodes
 * from. Plain objects are validated through the schema, so a programmatic
 * caller gets the same errors a bad file does.
 */
export type CaptureStateInput = CaptureState | Record<string, unknown>;

export type CaptureConfigOverrides = Partial<{
	outputDir: string;
	captureVideo: boolean;
	viewports: ReadonlyArray<ViewportConfigInput>;
	maxDepth: number;
	waitTime: number;
	videoOptions: VideoOptionsInput;
	includeSubdomains: boolean;
	allowedHosts: ReadonlyArray<string>;
	routeConcurrency: number;
	menuInteractionSelectors: ReadonlyArray<string>;
	screenshotHideSelectors: ReadonlyArray<string>;
	ffmpegPath: string;
	warmupScroll: boolean;
	launchArgs: ReadonlyArray<string>;
	colorScheme: "light" | "dark" | "no-preference";
	states: ReadonlyArray<CaptureStateInput>;
	stateTimeout: number;
	captureRoutes: boolean;
	allowStateRequests: boolean;
}>;

const toViewportInstance = (viewport: ViewportConfigInput): ViewportConfig =>
	viewport instanceof ViewportConfig ? viewport : new ViewportConfig(viewport);

const toVideoOptionsInstance = (
	input: VideoOptionsInput | undefined,
	fallback: VideoOptions,
): VideoOptions =>
	input instanceof VideoOptions
		? input
		: new VideoOptions({
				duration: fallback.duration,
				interactions: fallback.interactions,
				...(input ?? {}),
			});

const decodeCaptureState = S.decodeUnknownSync(CaptureState);

const toCaptureStateInstance = (input: CaptureStateInput): CaptureState =>
	input instanceof CaptureState ? input : decodeCaptureState(input);

export const createCaptureConfig = (
	overrides: CaptureConfigOverrides = {},
): CaptureConfig => {
	const base = CaptureConfig.Default;

	const viewports = overrides.viewports
		? overrides.viewports.map(toViewportInstance)
		: base.viewports.map(toViewportInstance);

	const videoOptions =
		overrides.videoOptions !== undefined
			? toVideoOptionsInstance(overrides.videoOptions, base.videoOptions)
			: base.videoOptions;

	const states = overrides.states
		? overrides.states.map(toCaptureStateInstance)
		: base.states;

	return new CaptureConfig({
		...base,
		...overrides,
		viewports,
		videoOptions,
		states,
		allowedHosts: overrides.allowedHosts
			? Array.from(overrides.allowedHosts)
			: base.allowedHosts,
		menuInteractionSelectors: overrides.menuInteractionSelectors
			? Array.from(overrides.menuInteractionSelectors)
			: base.menuInteractionSelectors,
		screenshotHideSelectors: overrides.screenshotHideSelectors
			? Array.from(overrides.screenshotHideSelectors)
			: base.screenshotHideSelectors,
		ffmpegPath: overrides.ffmpegPath ?? base.ffmpegPath,
		warmupScroll: overrides.warmupScroll ?? base.warmupScroll,
		launchArgs: overrides.launchArgs
			? Array.from(overrides.launchArgs)
			: base.launchArgs,
		colorScheme: overrides.colorScheme ?? base.colorScheme,
		stateTimeout: overrides.stateTimeout ?? base.stateTimeout,
		captureRoutes: overrides.captureRoutes ?? base.captureRoutes,
		allowStateRequests: overrides.allowStateRequests ?? base.allowStateRequests,
	});
};
