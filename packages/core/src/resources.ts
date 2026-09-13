import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { CreateToolsDeps } from "./tools/_helpers.js";
import { getCard, listMyCards, listPublicIcons } from "./yoto/endpoints.js";

/**
 * Registers the 3 read-only resources from the plan: `yoto://cards`,
 * `yoto://card/{cardId}`, and `yoto://icons/public`. All three are thin
 * JSON views over the same endpoints the tools use -- useful for a client
 * that wants to browse context without making a tool call.
 */
export function registerResources(server: McpServer, deps: CreateToolsDeps): void {
  server.registerResource(
    "yoto-cards",
    "yoto://cards",
    {
      title: "Your Yoto cards",
      description: "The signed-in parent's MYO (Make Your Own) cards.",
      mimeType: "application/json",
    },
    async (uri) => {
      const cards = await listMyCards(deps.client);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(cards, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "yoto-card",
    new ResourceTemplate("yoto://card/{cardId}", { list: undefined }),
    {
      title: "A Yoto card",
      description: "One card's full details -- every chapter and track.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const cardId = Array.isArray(variables.cardId) ? variables.cardId[0] : variables.cardId;
      const card = await getCard(deps.client, String(cardId));
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(card, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "yoto-icons-public",
    "yoto://icons/public",
    {
      title: "Yoto's public icon catalogue",
      description: "Searchable 16x16 pixel-art icons available to every account.",
      mimeType: "application/json",
    },
    async (uri) => {
      const icons = await listPublicIcons(deps.client);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(icons, null, 2),
          },
        ],
      };
    },
  );
}
