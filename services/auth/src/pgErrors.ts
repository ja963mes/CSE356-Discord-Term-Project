/**
 * Drizzle wraps node-postgres errors; unique violations use code 23505 on `cause`.
 */
export function isUniqueConstraintViolation(err: unknown, constraintName: string): boolean {
  const c = (err as { cause?: { code?: string; constraint?: string } })?.cause;
  return c?.code === "23505" && c?.constraint === constraintName;
}
