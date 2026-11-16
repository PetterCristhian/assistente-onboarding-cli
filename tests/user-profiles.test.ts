// Structure of the user profiles of context/03-usuario/ (layer 3 of
// docs/adr/0003-contexto-em-quatro-camadas.md). No name is written here. The
// contract is the one that the loader applies (src/context/types.ts).
import { describe, expect, it } from "vitest";
import { userProfileSchema, type UserProfile } from "../src/context/types.js";
import { listContextFolder, readContextFile } from "./helpers/context-files.js";

const PROFILE_FOLDER = "03-usuario";
const PROFILE_COUNT = 2;

const PROFILE_FILES = listContextFolder(PROFILE_FOLDER).filter((path) =>
  path.endsWith(".json"),
);

function readProfile(path: string): UserProfile {
  const parsed: unknown = JSON.parse(readContextFile(path));
  return userProfileSchema.parse(parsed);
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

    expect(userProfileSchema.safeParse(parsed).success).toBe(true);
  });

  it.each(["2026-02-31", "2026-13-01", "2026-1-5", "05/01/2026"])(
    "has a contract that refuses the start date %s",
    (dataInicio) => {
      const [path = ""] = PROFILE_FILES;
      const profile = { ...readProfile(path), dataInicio };

      // An impossible day, such as the 31st of a short month, does not survive.
      expect(userProfileSchema.safeParse(profile).success).toBe(false);
    },
  );

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
