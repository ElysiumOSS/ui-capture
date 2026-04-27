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

export class CaptureResult extends S.Class<CaptureResult>("CaptureResult")({
	url: S.String,
	route: S.String,
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
	});
}

export class CaptureReport extends S.Class<CaptureReport>("CaptureReport")({
	timestamp: S.String,
	totalRoutes: S.Number.pipe(S.int(), S.nonNegative()),
	successfulCaptures: S.Number.pipe(S.int(), S.nonNegative()),
	failedCaptures: S.Number.pipe(S.int(), S.nonNegative()),
	viewports: S.Array(ViewportConfig),
	results: S.Array(
		S.Struct({
			url: S.String,
			route: S.String,
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

	return new CaptureConfig({
		...base,
		...overrides,
		viewports,
		videoOptions,
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
	});
};
