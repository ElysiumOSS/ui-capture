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

export class BrowserError extends S.TaggedError<BrowserError>()(
	"BrowserError",
	{
		message: S.String,
		cause: S.Unknown,
	},
) {}

export class CaptureError extends S.TaggedError<CaptureError>()(
	"CaptureError",
	{
		url: S.String,
		message: S.String,
		cause: S.Unknown,
	},
) {}

export class FileSystemError extends S.TaggedError<FileSystemError>()(
	"FileSystemError",
	{
		path: S.String,
		operation: S.String,
		cause: S.Unknown,
	},
) {}

/**
 * A scripted state that could never have worked: a duplicate or unknown name,
 * an `extends` cycle, an off-host `request` path, a viewport filter naming a
 * viewport that is not configured.
 *
 * Definition errors are raised before Chromium launches and abort the run,
 * because no amount of retrying makes a typo'd `extends` resolve. Runtime
 * problems are {@link StateCaptureError} instead, and are recorded per state
 * so one broken script cannot abort a capture run.
 */
export class StateDefinitionError extends S.TaggedError<StateDefinitionError>()(
	"StateDefinitionError",
	{
		state: S.String,
		message: S.String,
		cause: S.Unknown,
	},
) {}

/**
 * A scripted state that failed while running: a selector that never appeared,
 * an action that threw, a seeding request that returned the wrong status, or
 * the whole state exceeding its budget.
 *
 * `stepIndex: -1` with `stepKind: "state"` denotes a whole-state failure
 * (navigation or timeout) rather than one attributable step.
 */
export class StateCaptureError extends S.TaggedError<StateCaptureError>()(
	"StateCaptureError",
	{
		state: S.String,
		stepIndex: S.Number,
		stepKind: S.String,
		target: S.String,
		message: S.String,
		cause: S.Unknown,
	},
) {}
