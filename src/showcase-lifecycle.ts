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
import type { Browser, BrowserContext } from "playwright";

/** Allow recording flush, then fall back to closing the owning browser. */
export const closeShowcaseContext = async (
	context: Pick<BrowserContext, "close">,
	browser: Pick<Browser, "close">,
	graceMs = 5000,
): Promise<boolean> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		const timedOut = await Promise.race([
			context.close().then(
				() => false,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), graceMs);
			}),
		]);
		// Playwright's browser.close has its own 30-second graceful-close/kill guard.
		if (timedOut) await browser.close().catch(() => {});
		return timedOut;
	} finally {
		clearTimeout(timer);
	}
};

/** A stalled artifact must not keep the caller waiting after browser teardown. */
export const finalizeShowcaseArtifact = async <T>(
	operation: Promise<T>,
	timeoutMs = 5000,
): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								"Showcase recording artifact did not finalize within its cleanup budget",
							),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
