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
import { Effect } from "effect";
import type { Page } from "playwright";
import { CaptureError } from "./errors.js";

export interface WarmupOptions {
	readonly steps?: number;
	readonly settleMs?: number;
}

/**
 * Scrolls the page from top to bottom in N steps, then back to top, waiting
 * a short settle period at each step. Triggers IntersectionObserver-based
 * lazy-loaded media and primes scroll-reveal animations so a subsequent
 * `fullPage` screenshot captures real content rather than skeleton placeholders.
 *
 * Has no effect on true scroll-progress-driven parallax (those evaluate at
 * scroll=0 once we return to top); a stitched-capture mode is the right tool
 * for that case.
 */
export const performWarmupScroll = (
	page: Page,
	url: string,
	options: WarmupOptions = {},
): Effect.Effect<void, CaptureError> => {
	const steps = options.steps ?? 8;
	const settleMs = options.settleMs ?? 250;

	return Effect.tryPromise({
		try: async () => {
			await page.evaluate(
				async (args: { steps: number; settleMs: number }) => {
					const sleep = (ms: number) =>
						new Promise<void>((r) => setTimeout(r, ms));
					const nextFrame = () =>
						new Promise<void>((r) =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() => r()),
							),
						);

					const docEl = document.documentElement;
					const body = document.body;
					const totalHeight = Math.max(
						docEl.scrollHeight,
						body?.scrollHeight ?? 0,
					);
					const viewport = window.innerHeight || 1;
					const stepSize = Math.max(
						viewport / 2,
						(totalHeight - viewport) / Math.max(args.steps, 1),
					);

					for (let i = 1; i <= args.steps; i++) {
						const target = Math.min(stepSize * i, totalHeight);
						window.scrollTo({ top: target, behavior: "auto" });
						await nextFrame();
						await sleep(args.settleMs);
						if (target >= totalHeight) break;
					}

					window.scrollTo({ top: 0, behavior: "auto" });
					await nextFrame();
				},
				{ steps, settleMs },
			);
		},
		catch: (error) =>
			new CaptureError({
				url,
				message: "Warm-up scroll failed",
				cause: error,
			}),
	});
};
