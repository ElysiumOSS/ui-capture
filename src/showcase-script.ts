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
import { Effect, Ref } from "effect";
import type { Page } from "playwright";
import type { ShowcaseStep } from "./showcase-schema.js";
import { isExpectedStatus, resolveRequestUrl } from "./state-plan.js";
import {
	createScriptedStateRunner,
	INITIAL_STEP_PROGRESS,
} from "./state-script.js";

/** Reuse the state driver while keeping showcase-only transient actions separate. */
export const runShowcaseStep = async (
	page: Page,
	step: ShowcaseStep,
	isAllowed: (url: URL) => boolean,
	signal: AbortSignal,
): Promise<void> => {
	signal.throwIfAborted();
	const timeout = step.timeoutMs ?? 5000;
	switch (step.kind) {
		case "type": {
			const input = page.locator(step.selector).first();
			if (step.clear) await input.fill("", { timeout });
			await input.pressSequentially(step.value, {
				delay: step.delayMs,
				timeout,
			});
			return;
		}
		case "hover":
			await page.locator(step.selector).nth(step.nth).hover({ timeout });
			return;
		case "scroll":
			await page.evaluate(
				({ x, y, durationMs }) =>
					new Promise<void>((resolve) => {
						const start = performance.now();
						const fromX = scrollX;
						const fromY = scrollY;
						const tick = () => {
							const progress =
								durationMs === 0
									? 1
									: Math.min(1, (performance.now() - start) / durationMs);
							const eased =
								progress < 0.5
									? 2 * progress * progress
									: 1 - (-2 * progress + 2) ** 2 / 2;
							window.scrollTo({
								left: fromX + (x - fromX) * eased,
								top: fromY + (y - fromY) * eased,
								behavior: "instant",
							});
							if (progress === 1) resolve();
							else requestAnimationFrame(tick);
						};
						tick();
					}),
				{ x: step.x, y: step.y, durationMs: step.durationMs },
			);
			return;
		case "request": {
			let url = resolveRequestUrl(step.path, page.url());
			let method: string = step.method;
			let json = step.json;
			const deadline = Date.now() + timeout;
			for (let redirect = 0; redirect <= 10; redirect++) {
				signal.throwIfAborted();
				if (!isAllowed(url))
					throw new Error(`request outside allowed origins: ${url}`);
				const remaining = deadline - Date.now();
				if (remaining <= 0)
					throw new Error(`request timed out after ${timeout}ms`);
				const response = await page.request.fetch(url.toString(), {
					method,
					headers: step.headers,
					...(json === undefined ? {} : { data: json }),
					maxRedirects: 0,
					timeout: remaining,
				});
				try {
					const status = response.status();
					const location = response.headers().location;
					if (location && [301, 302, 303, 307, 308].includes(status)) {
						url = resolveRequestUrl(location, url.toString());
						if (
							status === 303 ||
							((status === 301 || status === 302) && method === "POST")
						) {
							method = "GET";
							json = undefined;
						}
						continue;
					}
					if (!isExpectedStatus(status, step.expectStatus))
						throw new Error(
							`expected ${step.expectStatus ?? "2xx"}, got ${status}`,
						);
					return;
				} finally {
					await response.dispose();
				}
			}
			throw new Error("request exceeded 10 redirects");
		}
		default: {
			const runner = createScriptedStateRunner({
				isAllowedRequestUrl: isAllowed,
			});
			// Showcase owns optional results, settlement, and the real index in its report.
			await Effect.runPromise(
				Effect.gen(function* () {
					const progress = yield* Ref.make(INITIAL_STEP_PROGRESS);
					yield* runner.runStateScript(
						page,
						"showcase",
						[{ ...step, optional: false, settleMs: 0 }],
						progress,
					);
				}),
				{ signal },
			);
		}
	}
};
