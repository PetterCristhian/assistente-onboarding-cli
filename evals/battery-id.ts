// The name of the folder of one battery in outputs/: the UTC start time with
// no milliseconds and no colons (Windows does not allow them in a name).
// Pure: the clock and the disk are passed in.

const MAX_SUFFIX = 1000;

/** "2026-11-20T14-30-00Z" for 2026-11-20T14:30:00.412Z. */
export function batteryIdFrom(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("A data de início da bateria não é válida.");
  }
  const year = date.getUTCFullYear();
  if (year < 1000 || year > 9999) {
    throw new RangeError(
      "O ano da data de início da bateria deve ter quatro dígitos (1000 a 9999).",
    );
  }
  return `${date.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

/**
 * The id of the start time, or that id with "-2", "-3"... when a folder of
 * that name exists already (two batteries started in the same second).
 */
export function uniqueBatteryId(
  date: Date,
  exists: (id: string) => boolean,
): string {
  const base = batteryIdFrom(date);
  if (!exists(base)) {
    return base;
  }
  for (let suffix = 2; suffix <= MAX_SUFFIX; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Não foi possível escolher um nome livre para a bateria.`);
}
