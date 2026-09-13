import { z } from "zod";
import { YotoError } from "../errors.js";
import { listMyCards } from "../yoto/endpoints.js";
import type { AnyToolSpec, CreateToolsDeps } from "./_helpers.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createAuthTools(deps: CreateToolsDeps): AnyToolSpec[] {
  const yotoStatus: AnyToolSpec = {
    name: "yoto_status",
    title: "Check Yoto sign-in status",
    description:
      "Reports whether this connection is signed in to Yoto, which mode it's running in " +
      "(cli or remote), where the credential is stored, its granted scopes, and whether " +
      "the Yoto API is currently reachable.",
    group: "auth",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: z.object({}),
    outputSchema: z.object({
      signedIn: z.boolean(),
      mode: z.enum(["cli", "remote"]),
      tokenStore: z.enum(["keychain", "file", "remote"]).optional(),
      expiresAt: z.number().optional(),
      scopes: z.array(z.string()).optional(),
      hint: z.string().optional(),
      apiReachable: z.boolean().optional(),
    }),
    summary: (output) =>
      output.signedIn
        ? `Signed in to Yoto (${output.mode} mode)${output.apiReachable === false ? " -- API unreachable right now" : ""}.`
        : `Not signed in to Yoto.${output.hint ? ` ${output.hint}` : ""}`,
    handler: async () => {
      const status = await deps.auth.status();
      let apiReachable: boolean | undefined;
      if (status.signedIn) {
        try {
          await listMyCards(deps.client);
          apiReachable = true;
        } catch {
          apiReachable = false;
        }
      }
      return { ...status, apiReachable };
    },
  };

  const yotoSignIn: AnyToolSpec = {
    name: "yoto_sign_in",
    title: "Sign in to Yoto",
    description:
      "CLI mode: launches a local PKCE sign-in flow (opens your browser to Yoto's login " +
      "page and waits for the callback). Remote mode: this connector runs on a server " +
      "with nothing to launch, so it returns instructions to sign in from your AI client's " +
      "connector settings instead -- that flow redirects to Yoto's own login page too.",
    group: "auth",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      openBrowser: z
        .boolean()
        .optional()
        .describe("CLI only: open the sign-in URL automatically. Default true."),
    }),
    outputSchema: z.object({
      url: z.string().optional(),
      message: z.string(),
    }),
    summary: (output) => output.message,
    handler: async (args) => {
      if (deps.mode === "remote") {
        return {
          message:
            "This is a remote connector -- sign in from your AI client's connector/integration " +
            "settings, which redirects you to Yoto's own login page. There's nothing to run here.",
        };
      }
      if (!deps.auth.signIn) {
        throw new YotoError("Sign-in isn't available on this connection.", {
          code: "UNSUPPORTED_IN_MODE",
        });
      }
      return deps.auth.signIn({ openBrowser: args.openBrowser });
    },
  };

  const yotoSignOut: AnyToolSpec = {
    name: "yoto_sign_out",
    title: "Sign out of Yoto",
    description:
      "CLI mode: deletes the locally stored Yoto credential (keychain or file). Remote " +
      "mode: this server never stores your Yoto token at all, so it returns instructions " +
      "for disconnecting from your AI client and revoking access at Yoto directly. " +
      "Requires confirm: true.",
    group: "auth",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      confirm: z.boolean().describe("Must be true -- this clears your stored Yoto credential."),
    }),
    outputSchema: z.object({ message: z.string() }),
    summary: (output) => output.message,
    handler: async (args) => {
      if (!args.confirm) {
        throw new YotoError("Pass confirm: true to sign out.", {
          code: "VALIDATION",
          hint: "This clears your locally stored Yoto credential.",
        });
      }
      if (deps.mode === "remote") {
        return {
          message:
            "This server never stores your Yoto token -- disconnect it from your AI client's " +
            "connector settings, and optionally revoke access in your Yoto account's security settings.",
        };
      }
      if (!deps.auth.signOut) {
        throw new YotoError("Sign-out isn't available on this connection.", {
          code: "UNSUPPORTED_IN_MODE",
        });
      }
      await deps.auth.signOut();
      return { message: "Signed out of Yoto. Run yoto_sign_in to reconnect." };
    },
  };

  return [yotoStatus, yotoSignIn, yotoSignOut];
}
