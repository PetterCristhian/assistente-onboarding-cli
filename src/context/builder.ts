// Assembles the four layers into the single context text. Pure: no disk, no
// clock and no environment (docs/adr/0003-contexto-em-quatro-camadas.md).
import {
  ContextError,
  hasLineBreak,
  type BuiltContext,
  type ContextLayers,
  type ContextSections,
} from "./types.js";

export const LAYER_MARKERS = {
  globalInstructions: "instrucoes_globais",
  policies: "politicas",
  userData: "dados_do_usuario",
  companyData: "dados_da_empresa",
} as const;

type LayerKey = keyof typeof LAYER_MARKERS;

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

// An opening or closing marker of any layer, also in capital letters or with
// blanks inside: content that holds one could close its section early.
const RESERVED_MARKER = new RegExp(
  `<\\s*/?\\s*(?:${Object.values(LAYER_MARKERS).join("|")})\\s*>`,
  "i",
);

function refuseReservedMarkers(layer: LayerKey, contents: string[]): void {
  for (const content of contents) {
    const found = RESERVED_MARKER.exec(content)?.[0];
    if (found !== undefined) {
      throw new ContextError(
        `A camada "${LAYER_NAMES[layer]}" contém o marcador reservado "${found}", que não pode aparecer no conteúdo.`,
      );
    }
  }
}

function section(layer: LayerKey, body: string): string {
  const marker = LAYER_MARKERS[layer];
  return `<${marker}>\n${body}\n</${marker}>`;
}

export function buildContext(layers: ContextLayers): BuiltContext {
  const { nome, cargo, area, dataInicio, gestor } = layers.userProfile;
  const documents = layers.companyData.map((document) => document.content);

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
  refuseReservedMarkers("companyData", documents);

  // The loader of the profile refuses a line break in its values; the date
  // comes from the entry point and is checked here.
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
    companyData: section("companyData", documents.join("\n\n")),
  };

  return {
    sections,
    text: [
      sections.globalInstructions,
      sections.policies,
      sections.userData,
      sections.companyData,
    ].join("\n\n"),
  };
}
