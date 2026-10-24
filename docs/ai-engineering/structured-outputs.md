# Structured outputs

Model output is **never trusted because it looks like JSON.** Parse and validate it
before use.

## The pattern in AURA

The simulator returns structured JSON per `kind`
(`plan`/`attack`/`defense`/`test`/`decision`/…), and live Claude is prompted to
match. Consumers decode defensively with `parseJSON<T>(text, fallback)`:

```ts
import { parseJSON } from "@/lib/utils";
// executeTask.ts — QA result:
const testResult = parseJSON(qa.text, { passed: 1, failed: 0, total: 1 });
```

`parseJSON` never throws — it returns the fallback on malformed input. That turns
"the model produced garbage" into a recoverable default instead of a crash.

## Rules

1. **Define the shape** you expect (a TS interface, or a Zod schema for anything
   crossing a trust boundary).
2. **Decode, don't cast.** `JSON.parse(x) as T` is a lie; use `parseJSON<T>(x,
   fallback)` or `Schema.parse`/`safeParse`.
3. **Provide a safe fallback** that keeps the workflow correct (e.g. a failing/empty
   result, not a fake success). For the quality gate, a malformed QA result must
   not read as "tests passed".
4. **Distinguish invalid data from a recoverable model failure.** A malformed
   response is a model failure → use the fallback and, where it matters, flag it or
   retry once. A well-formed response with disallowed values is invalid data →
   reject (don't coerce silently).
5. **Reject unsupported fields** when the shape is security-relevant — don't let
   extra keys through into state.
6. **Version schemas** when the shape changes; keep the decoder tolerant of old
   data in JSON columns (always a fallback).

## Where to use Zod vs parseJSON

- **Zod**: request bodies (`parseBody`), and model output that drives a
  security-relevant or persisted decision — validate values, not just shape.
- **parseJSON**: internal/simulated structured text and JSON DB columns where a
  typed fallback is the right recovery.

## Example: validating model output with Zod

```ts
import { z } from "zod";
const PlanSchema = z.object({
  strategy: z.string(),
  tasks: z.array(z.object({ title: z.string(), assignee: z.string() })).max(20),
});
const parsed = PlanSchema.safeParse(JSON.parse(result.text));
if (!parsed.success) {
  // recoverable model failure → fallback or one bounded retry, flagged
}
```
