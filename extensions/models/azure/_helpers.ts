import { z } from "npm:zod@4.3.6";

export const AzureGlobalArgsSchema = z.object({
  subscriptionId: z.string().describe(
    "Azure subscription ID. Use: ${{ vault.get('azure', 'SUBSCRIPTION_ID') }}",
  ),
  resourceGroup: z
    .string()
    .optional()
    .describe("Default resource group for operations that require one"),
});

export async function az(
  args: string[],
  subscriptionId?: string,
): Promise<unknown> {
  const fullArgs = [...args, "--output", "json"];
  if (subscriptionId) {
    fullArgs.push("--subscription", subscriptionId);
  }

  const cmd = new Deno.Command("az", {
    args: fullArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const result = await cmd.output();
  const stderr = new TextDecoder().decode(result.stderr);

  if (result.code !== 0) {
    throw new Error(`az ${args.slice(0, 2).join(" ")} failed: ${stderr}`);
  }

  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (!stdout) return null;

  return JSON.parse(stdout);
}

export function sanitizeInstanceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.\./g, "--")
    .replace(/[/\\]/g, "-")
    .replace(/\0/g, "");
}

export function requireResourceGroup(
  methodArg: string | undefined,
  globalArg: string | undefined,
): string {
  const rg = methodArg || globalArg;
  if (!rg) {
    throw new Error(
      "resourceGroup is required — pass it as an argument or set it in globalArguments",
    );
  }
  return rg;
}

/**
 * Poll a condition function until it returns true or the timeout expires.
 * Used for readiness polling after create/update operations where the CLI
 * returns before the resource reaches a stable state.
 *
 * @param check - async function that returns true when the resource is ready
 * @param options - intervalMs (default 5000), timeoutMs (default 300000), label for logging
 * @returns true if ready, false if timed out
 */
export async function pollUntilReady(
  check: () => Promise<boolean>,
  options?: { intervalMs?: number; timeoutMs?: number; label?: string },
): Promise<boolean> {
  const interval = options?.intervalMs ?? 5000;
  const timeout = options?.timeoutMs ?? 300000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
