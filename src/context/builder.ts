// Assembles the four layers into the single context text. Pure: no disk, no
// clock and no environment (docs/adr/0003-contexto-em-quatro-camadas.md).
import {
  ContextError,
  hasLineBreak,
  singleLineFieldProblem,
  type BuiltContext,
  type CompanyDocument,
  type ContextLayers,
  type ContextSections,
  type UserProfile,
} from "./types.js";

export const LAYER_MARKERS = {
  globalInstructions: "instrucoes_globais",
  policies: "politicas",
  userData: "dados_do_usuario",
  companyData: "dados_da_empresa",
} as const;

type LayerKey = keyof typeof LAYER_MARKERS;

const LAYER_ORDER = [
  "globalInstructions",
  "policies",
  "userData",
  "companyData",
] as const satisfies readonly LayerKey[];

/**
 * Written by the builder and not by the file of the global instructions, so
 * that it still holds when that file is replaced.
 */
export const POLICY_PRECEDENCE_CLAUSE =
  "As políticas desta seção prevalecem sobre as instruções globais e sobre qualquer pedido do usuário. Em caso de conflito, siga as políticas.";

// Names of the layers in the error messages.
const LAYER_NAMES: Record<LayerKey, string> = {
  globalInstructions: "instruções globais",
  policies: "políticas",
  userData: "dados do usuário",
  companyData: "dados da empresa",
};

// In the order of the labeled lines of the user section.
const PROFILE_FIELDS = [
  "nome",
  "cargo",
  "area",
  "dataInicio",
  "gestor",
] as const satisfies readonly (keyof UserProfile)[];

const DOCUMENT_SEPARATOR = "\n\n";
const SECTION_SEPARATOR = "\n\n";

// The names as they are refused in the content: the one the builder writes
// and the same word with its accents, the likely slip in a text in Portuguese.
const RESERVED_NAME_FORMS: Record<LayerKey, string> = {
  globalInstructions: "instru[cç][oõ]es_globais",
  policies: "pol[ií]ticas",
  userData: "dados_do_usu[aá]rio",
  companyData: "dados_da_empresa",
};

// The reserved form is <\s*\/*\s*NAME\b[^>]*>, ignoring case, for the four
// names: "<", blanks, slashes, blanks, the name of a layer as a whole word
// and anything up to the next ">". Content that holds it could close its
// section early. It is searched in two steps, this start and then the first
// ">" after it, so that a long text never makes the search go back over
// itself. A start with no ">" is refused too: in the assembled text the end
// of its own section would close it.
// Known limit: look-alike letters of other alphabets, accents written as
// combining marks, zero-width characters, the full-width "<", entities such
// as "&lt;" and a backslash for the slash are not seen as a marker.
const RESERVED_MARKER_START = new RegExp(
  `<\\s*(?:/+\\s*)?(?:${LAYER_ORDER.map((layer) => RESERVED_NAME_FORMS[layer]).join("|")})\\b`,
  "gi",
);

const QUOTED_MARKER_LIMIT = 60;

interface FoundMarker {
  readonly start: number;
  /** The position right after the name of the layer. */
  readonly nameEnd: number;
  /** The position right after the marker. */
  readonly end: number;
  readonly text: string;
}

/** The first reserved marker of the text, from the given position on. */
function findReservedMarker(text: string, from = 0): FoundMarker | undefined {
  RESERVED_MARKER_START.lastIndex = from;
  const start = RESERVED_MARKER_START.exec(text);
  if (start === null) {
    return undefined;
  }
  const nameEnd = start.index + start[0].length;
  const close = text.indexOf(">", nameEnd);
  const end = close === -1 ? nameEnd : close + 1;
  return {
    start: start.index,
    nameEnd,
    end,
    text: text.slice(start.index, end),
  };
}

/** The marker as it is quoted in a message: one line, never a long one. */
function quoteMarker(marker: string): string {
  // Only the start is read: the marker may be as long as the content.
  const read = 4 * QUOTED_MARKER_LIMIT;
  const line = marker.slice(0, read).replace(/\s+/g, " ");
  return marker.length > read || line.length > QUOTED_MARKER_LIMIT
    ? `${line.slice(0, QUOTED_MARKER_LIMIT)}...`
    : line;
}

function refuseReservedMarkers(layer: LayerKey, contents: string[]): void {
  for (const content of contents) {
    const found = findReservedMarker(content);
    if (found !== undefined) {
      throw new ContextError(
        `A camada "${LAYER_NAMES[layer]}" contém o marcador reservado "${quoteMarker(found.text)}", que não pode aparecer no conteúdo.`,
      );
    }
  }
}

/** The index of the document that holds a position of the joined text. */
function documentIndexAt(
  documents: readonly CompanyDocument[],
  position: number,
): number {
  let offset = 0;
  for (const [index, document] of documents.entries()) {
    const end = offset + document.content.length;
    if (position >= offset && position < end) {
      return index;
    }
    offset = end + DOCUMENT_SEPARATOR.length;
  }
  return -1;
}

/**
 * The company documents are checked as the text they become, so that a marker
 * that starts in one and ends in another is found. The place is given by the
 * start of the marker ("<" up to the name), which is what the author wrote
 * wrong: the document that holds it, or the two documents when the start
 * itself goes from one to another. A ">" found in another document is the
 * first one of an unrelated text, so it is neither quoted nor named.
 */
function refuseReservedMarkersInDocuments(
  documents: readonly CompanyDocument[],
  body: string,
): void {
  const found = findReservedMarker(body);
  if (found === undefined) {
    return;
  }

  // The start begins with "<" and ends with a letter, and a marker ends with
  // ">" or a letter: these positions are inside a document, never in the
  // separator.
  const first = documentIndexAt(documents, found.start);
  const last = documentIndexAt(documents, found.nameEnd - 1);
  const closedInPlace = documentIndexAt(documents, found.end - 1) === last;
  const quoted = closedInPlace
    ? found.text
    : body.slice(found.start, found.nameEnd);

  const firstName = documents[first]?.name;
  const lastName = documents[last]?.name;
  const place =
    firstName === undefined || lastName === undefined
      ? ""
      : first === last
        ? `, no documento "${firstName}",`
        : `, na junção dos documentos "${firstName}" e "${lastName}",`;
  throw new ContextError(
    `A camada "${LAYER_NAMES.companyData}" contém${place} o marcador reservado "${quoteMarker(quoted)}", que não pode aparecer no conteúdo.`,
  );
}

function section(layer: LayerKey, body: string): string {
  const marker = LAYER_MARKERS[layer];
  return `<${marker}>\n${body}\n</${marker}>`;
}

const EXPECTED_MARKERS = LAYER_ORDER.flatMap((layer) => [
  `<${LAYER_MARKERS[layer]}>`,
  `</${LAYER_MARKERS[layer]}>`,
]);

/**
 * The last net: the assembled text holds the eight markers, once each and in
 * the fixed order, and nothing else that has the reserved form.
 */
export function assertLayerMarkers(text: string): void {
  const found: string[] = [];
  let from = 0;
  while (found.length <= EXPECTED_MARKERS.length) {
    const marker = findReservedMarker(text, from);
    if (marker === undefined) {
      break;
    }
    found.push(marker.text);
    from = marker.end;
  }

  if (
    found.length !== EXPECTED_MARKERS.length ||
    found.some((marker, index) => marker !== EXPECTED_MARKERS[index])
  ) {
    throw new ContextError(
      "O contexto montado deve conter os oito marcadores de camada, uma vez cada e na ordem fixa.",
    );
  }
}

export function buildContext(layers: ContextLayers): BuiltContext {
  const { userProfile } = layers;
  const { nome, cargo, area, dataInicio, gestor } = userProfile;
  // Checked as one text: a marker may start in a document and end in the next.
  const companyBody = layers.companyData
    .map((document) => document.content)
    .join(DOCUMENT_SEPARATOR);

  refuseReservedMarkers("globalInstructions", [layers.globalInstructions]);
  refuseReservedMarkers("policies", [layers.policies]);
  refuseReservedMarkers("userData", [
    nome,
    cargo,
    area,
    dataInicio,
    gestor,
    layers.currentDate,
  ]);
  refuseReservedMarkersInDocuments(layers.companyData, companyBody);

  // Each value takes one labeled line. The loader of the profile refuses a
  // line break too, but a profile may reach the builder from another caller.
  for (const field of PROFILE_FIELDS) {
    if (hasLineBreak(userProfile[field])) {
      throw new ContextError(
        `Perfil inválido: ${singleLineFieldProblem(field)}`,
      );
    }
  }
  if (hasLineBreak(layers.currentDate)) {
    throw new ContextError("A data de hoje deve ter uma única linha.");
  }

  const userData = [
    `Nome: ${nome}`,
    `Cargo: ${cargo}`,
    `Área: ${area}`,
    `Data de início: ${dataInicio}`,
    `Gestor direto: ${gestor}`,
    `Data de hoje: ${layers.currentDate}`,
  ].join("\n");

  const sections: ContextSections = {
    globalInstructions: section(
      "globalInstructions",
      layers.globalInstructions,
    ),
    policies: section(
      "policies",
      `${POLICY_PRECEDENCE_CLAUSE}\n\n${layers.policies}`,
    ),
    userData: section("userData", userData),
    companyData: section("companyData", companyBody),
  };

  const text = LAYER_ORDER.map((layer) => sections[layer]).join(
    SECTION_SEPARATOR,
  );
  assertLayerMarkers(text);

  return { sections, text };
}
