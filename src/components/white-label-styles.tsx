import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getWhiteLabelConfig } from "@/lib/white-label";
import { isWhiteLabelEnabled } from "@/lib/feature-flags";

/**
 * Server component: injects the org's brand colour as CSS custom properties so
 * the Tailwind `accent` token (channel-format `rgb(var(--brand-primary-rgb)…)`)
 * rethemes app-wide. Renders nothing when white-label is off, no org, or no
 * colour set — so the token falls back to the default blue. The colour is
 * server-validated (`^#[0-9a-fA-F]{6}$`) so the inline <style> carries only a
 * parsed channel triple, never free text.
 */
export async function WhiteLabelStyles() {
  if (!isWhiteLabelEnabled()) return null;
  try {
    const session = await getServerSession(authOptions);
    const orgId = (session?.user as Record<string, unknown> | undefined)?.orgId as string | undefined;
    if (!orgId) return null;

    const config = await getWhiteLabelConfig(orgId);
    const hex = config.primaryColour;
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;

    // Hex → space-separated RGB channels for the `<alpha-value>` token format.
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const channels = `${r} ${g} ${b}`;
    const css = `:root{--brand-primary-rgb:${channels};--brand-primary-hover-rgb:${channels};}`;
    // eslint-disable-next-line react/no-danger
    return <style dangerouslySetInnerHTML={{ __html: css }} />;
  } catch {
    return null;
  }
}
