// Structure of the user profiles of context/03-usuario/ (layer 3 of
// docs/adr/0003-contexto-em-quatro-camadas.md). No name is written here.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listContextFolder, readContextFile } from "./helpers/context-files.js";

const PROFILE_FOLDER = "03-usuario";
const PROFILE_COUNT = 2;

const filledText = z
  .string()
  .refine((value) => value.trim() !== "" && value === value.trim());

// Local copy of the profile contract. ENG-47 replaces this schema by the one
// that src/context/ exports, so that the test and the loader share one source.
const profileSchema = z.strictObject({
  nome: filledText,
  cargo: filledText,
  area: filledText,
  dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gestor: filledText,
});

type Profile = z.infer<typeof profileSchema>;

const PROFILE_FILES = listContextFolder(PROFILE_FOLDER).filter((path) =>
  path.endsWith(".json"),
);

function readProfile(path: string): Profile {
  const parsed: unknown = JSON.parse(readContextFile(path));
  return profileSchema.parse(parsed);
}

/** "Érica D'Ávila" becomes "erica-d-avila". */
function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

describe("user profiles", () => {
  it("are exactly two JSON files, and nothing else is in the folder", () => {
    expect(PROFILE_FILES).toHaveLength(PROFILE_COUNT);
    expect(listContextFolder(PROFILE_FOLDER)).toEqual(PROFILE_FILES);
  });

  it.each(PROFILE_FILES)("gives %s exactly the five text fields", (path) => {
    const parsed: unknown = JSON.parse(readContextFile(path));

    expect(profileSchema.safeParse(parsed).success).toBe(true);
  });

  it.each(PROFILE_FILES)("writes in %s a start date that exists", (path) => {
    const { dataInicio } = readProfile(path);
    const date = new Date(`${dataInicio}T00:00:00Z`);

    // An impossible day, such as the 31st of a short month, does not survive.
    expect(Number.isNaN(date.getTime())).toBe(false);
    expect(date.toISOString().slice(0, 10)).toBe(dataInicio);
  });

  it.each(PROFILE_FILES)("names %s after the person it describes", (path) => {
    const { nome } = readProfile(path);

    expect(path).toBe(`${PROFILE_FOLDER}/${slug(nome)}.json`);
  });

  it.each(PROFILE_FILES)(
    "gives the person of %s a manager with a full name, who is someone else",
    (path) => {
      const { nome, gestor } = readProfile(path);

      expect(gestor.split(/\s+/).length).toBeGreaterThanOrEqual(2);
      expect(slug(gestor)).not.toBe(slug(nome));
    },
  );

  it("gives each person a different manager", () => {
    const managers = PROFILE_FILES.map((path) =>
      slug(readProfile(path).gestor),
    );

    expect(new Set(managers).size).toBe(PROFILE_COUNT);
  });

  it("describes different people", () => {
    const names = PROFILE_FILES.map((path) => slug(readProfile(path).nome));

    expect(new Set(names).size).toBe(PROFILE_COUNT);
  });
});
