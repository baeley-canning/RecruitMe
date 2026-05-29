import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getWhiteLabelConfig } from "@/lib/white-label";

/**
 * Server component: injects brand CSS custom properties when an org has white-label
 * config set. Renders nothing if no config is present.
 */
export async function WhiteLabelStyles() {
  try {
    const session = await getServerSession(authOptions);
    const orgId = (session?.user as Record<string, unknown> | undefined)?.orgId as string | undefined;
    if (!orgId) return null;

    const config = await getWhiteLabelConfig(orgId);
    if (!config.primaryColour) return null;

    const css = `:root { --brand-primary: ${config.primaryColour}; }`;
    // eslint-disable-next-line react/no-danger
    return <style dangerouslySetInnerHTML={{ __html: css }} />;
  } catch {
    return null;
  }
}
