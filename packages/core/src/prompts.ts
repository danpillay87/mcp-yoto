import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * Registers the 2 prompts from the plan: `bedtime_playlist_card` (build a
 * new card from a list of tracks) and `audit_card` (review one card for
 * anything that looks off). Both just draft an instruction for the model
 * to follow using the 15 tools -- neither touches the Yoto API itself.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "bedtime_playlist_card",
    {
      title: "Bedtime playlist card",
      description:
        "Draft a new Yoto card from a list of audio files or URLs, ready to upload as a bedtime playlist.",
      argsSchema: {
        files: z
          .string()
          .describe(
            "The audio files/URLs to include, one per line or comma-separated, in play order.",
          ),
        childName: z
          .string()
          .optional()
          .describe("The child's name, for a personalised card title."),
      },
    },
    async (args) => {
      const childPart = args.childName ? ` for ${args.childName}` : "";
      const titleHint = args.childName ? ` mentioning ${args.childName}` : "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Build a bedtime playlist card${childPart} from these tracks, in order:\n\n${args.files}\n\n` +
                "For each one: call yoto_upload_audio (or yoto_add_track once the card exists) to get a " +
                "mediaRef, then call yoto_create_card with all the resulting tracks. Give the card a warm, " +
                `bedtime-appropriate title${titleHint}, and ask before uploading anything.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "audit_card",
    {
      title: "Audit a Yoto card",
      description: "Review one Yoto card's chapters, tracks and icons for anything that looks off.",
      argsSchema: {
        cardId: z.string().describe("The Yoto card to audit."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Call yoto_get_card with cardId "${args.cardId}", then check: every chapter has a title and ` +
              "at least one track; track durations look sensible (not zero, not implausibly long); icons " +
              "(icon16x16) are set where it would help a child navigate; chapter and track ordering makes " +
              "sense. Report anything worth fixing, and ask before calling yoto_update_card.",
          },
        },
      ],
    }),
  );
}
