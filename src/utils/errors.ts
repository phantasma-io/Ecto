export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }

  if (typeof err === "string") {
    return err;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function formatErrorDetails(err: unknown, maxLength = 600): string {
  const raw =
    err instanceof Error ? err.stack || err.message || err.name : formatError(err);

  if (raw.length <= maxLength) {
    return raw;
  }

  return raw.substring(0, maxLength) + "...";
}

export function logError(
  context: string,
  err: unknown,
  meta?: Record<string, unknown>
): string {
  if (meta) {
    console.error(`[Ecto] ${context}`, meta, err);
  } else {
    console.error(`[Ecto] ${context}`, err);
  }

  return formatError(err);
}
