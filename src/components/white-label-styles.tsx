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

    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);

    // Luminance guard: the whole app puts white text on the accent
    // (`bg-accent text-white`). A genuinely light brand colour (pale yellow,
    // mint) makes that text unreadable. Use perceived brightness (YIQ) and, only
    // when the colour is clearly too light, darken it just enough to keep white
    // legible. Normal brand colours (the default blue ≈110, reds/greens/purples)
    // sit well under the threshold and pass through untouched.
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const MAX_BRIGHTNESS_FOR_WHITE = 165;
    if (brightness > MAX_BRIGHTNESS_FOR_WHITE) {
      const scale = MAX_BRIGHTNESS_FOR_WHITE / brightness;
      r = Math.round(r * scale);
      g = Math.round(g * scale);
      b = Math.round(b * scale);
    }

    // Distinct hover shade — without this the accent-hover token collapses to
    // the base colour and branded buttons lose their hover feedback. Darken the
    // (possibly already luminance-corrected) base by 15%.
    const hov = (c: number) => Math.round(c * 0.85);

    const channels = `${r} ${g} ${b}`;
    const hoverChannels = `${hov(r)} ${hov(g)} ${hov(b)}`;
    const css = `:root{--brand-primary-rgb:${channels};--brand-primary-hover-rgb:${hoverChannels};}`;
    return <style dangerouslySetInnerHTML={{ __html: css }} />;
  } catch {
    return null;
  }
}
