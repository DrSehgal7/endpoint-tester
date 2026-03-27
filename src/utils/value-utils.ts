export function summarizePayload(value: unknown, maxLength = 220): string {
  if (value == null) {
    return "No response payload";
  }

  if (typeof value === "string") {
    return value.slice(0, maxLength);
  }

  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

export function extractHttpStatus(value: unknown): number | null {
  const candidates = [
    getNumberByKey(value, "status"),
    getNumberByKey(value, "statusCode"),
    getNumberByKey(value, "code"),
  ].filter((candidate): candidate is number => typeof candidate === "number");

  return candidates.find((candidate) => candidate >= 100 && candidate <= 599) ?? null;
}

export function getStringAtPath(value: unknown, path: string[]): string | null {
  let current = value;

  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" ? current : null;
}

export function getStringByKey(value: unknown, wantedKey: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getStringByKey(item, wantedKey);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof nestedValue === "string") {
      return nestedValue;
    }

    const nested = getStringByKey(nestedValue, wantedKey);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function getNumberByKey(value: unknown, wantedKey: string): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getNumberByKey(item, wantedKey);
      if (nested != null) {
        return nested;
      }
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof nestedValue === "number") {
      return nestedValue;
    }

    const nested = getNumberByKey(nestedValue, wantedKey);
    if (nested != null) {
      return nested;
    }
  }

  return null;
}

export function findFirstId(value: unknown, preferredKeys: string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstId(item, preferredKeys);
      if (found) {
        return found;
      }
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;

  for (const key of preferredKeys) {
    const candidate = record[key];
    if (candidate) {
      const found = findFirstId(candidate, preferredKeys);
      if (found) {
        return found;
      }
    }
  }

  if (typeof record.id === "string") return record.id;
  if (typeof record.message_id === "string") return record.message_id;
  if (typeof record.event_id === "string") return record.event_id;

  for (const nested of Object.values(record)) {
    const found = findFirstId(nested, preferredKeys);
    if (found) {
      return found;
    }
  }

  return null;
}

export function findFirstStringByKey(value: unknown, wantedKey: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, wantedKey);
      if (found) {
        return found;
      }
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof nestedValue === "string") {
      return nestedValue;
    }

    const found = findFirstStringByKey(nestedValue, wantedKey);
    if (found) {
      return found;
    }
  }

  return null;
}
