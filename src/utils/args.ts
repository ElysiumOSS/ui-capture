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
 * CLI Utilities
 */

import { Schema } from "effect";

const ParsedArgs = Schema.Struct({
	positional: Schema.Array(Schema.String),
	options: Schema.Record({
		key: Schema.String,
		value: Schema.Union(Schema.String, Schema.Boolean),
	}),
});

export type ParsedArgs = Schema.Schema.Type<typeof ParsedArgs>;

/**
 * Basic command line argument parser
 * Supports --key value, --key=value, --flag, and positional arguments
 *
 * `valueFlags` names options whose value may itself look like a flag, so the
 * next token is consumed even when it starts with `--`. Chromium switches
 * passed to `--launch-args` are the motivating case: without this, a value
 * like `--enable-blink-features=X` would be parsed as a separate option.
 */
export function parseArgs(
	args: string[],
	booleanFlags: string[] = [],
	valueFlags: string[] = [],
): ParsedArgs {
	const positional: string[] = [];
	const options: Record<string, string | boolean> = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		if (arg.startsWith("--")) {
			const longArg = arg.slice(2);

			// Handle --key=value
			if (longArg.includes("=")) {
				const [key, ...valueParts] = longArg.split("=");
				if (key) {
					options[key] = valueParts.join("=");
				}
				continue;
			}

			const key = longArg;
			const nextArg = args[i + 1];

			// If it's a known boolean flag, don't consume next arg
			if (booleanFlags.includes(key)) {
				options[key] = true;
				continue;
			}

			// Declared value-taking flags swallow the next token verbatim.
			if (valueFlags.includes(key) && nextArg !== undefined) {
				options[key] = nextArg;
				i++;
				continue;
			}

			// If next arg exists and isn't another flag, consume it as value
			if (nextArg && !nextArg.startsWith("--")) {
				options[key] = nextArg;
				i++;
			} else {
				options[key] = true;
			}
		} else {
			positional.push(arg);
		}
	}

	return { positional, options };
}
