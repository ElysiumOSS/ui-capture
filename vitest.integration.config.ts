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
 */

import { defineConfig } from "vitest/config";

// Integration tests drive a real browser, so they intentionally skip the
// console-fail-test setup file used by the unit suite.
export default defineConfig({
	test: {
		include: [
			"src/integration.test.ts",
			"src/*.integration.test.ts",
			"src/showcase-export.test.ts",
		],
		exclude: ["lib", "node_modules"],
		testTimeout: 60_000,
		hookTimeout: 30_000,
	},
});
