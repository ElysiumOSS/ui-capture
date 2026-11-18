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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeShowcaseContext,
	finalizeShowcaseArtifact,
} from "./showcase-lifecycle.js";

afterEach(() => vi.useRealTimers());
describe("showcase teardown", () => {
	it("forces browser closure when context video flushing stalls", async () => {
		vi.useFakeTimers();
		const close = vi.fn(async () => {});
		const pending = closeShowcaseContext(
			{ close: () => new Promise<void>(() => {}) },
			{ close },
			50,
		);
		await vi.advanceTimersByTimeAsync(51);
		expect(close).toHaveBeenCalledOnce();
		await expect(pending).resolves.toBe(true);
	});
	it("does not force browser closure after a normal context flush", async () => {
		const close = vi.fn(async () => {});
		await expect(
			closeShowcaseContext({ close: async () => {} }, { close }, 50),
		).resolves.toBe(false);
		expect(close).not.toHaveBeenCalled();
	});
});

it("bounds a stalled recording artifact after browser closure", async () => {
	vi.useFakeTimers();
	const pending = finalizeShowcaseArtifact(new Promise<string>(() => {}), 50);
	const assertion = expect(pending).rejects.toThrow(/artifact.*cleanup budget/);
	await vi.advanceTimersByTimeAsync(51);
	await assertion;
});
