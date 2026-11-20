import { z } from 'zod';

type StripDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;

/**
 * Partial-update (PATCH/PUT) schema derived from a create schema.
 *
 * Zod 4 applies `.default()` even under `.partial()`, so an omitted field
 * would parse as its default and overwrite the stored value (e.g. a PUT
 * carrying only `keyword` would reset `priority` to 0). Unwrap top-level
 * defaults first so omitted fields stay `undefined`.
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.unwrap() : field,
    ]),
  ) as { [K in keyof S]: StripDefault<S[K]> };
  return z.object(shape).partial();
}
