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

    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    // Pick the INK to suit the brand colour, rather than bending the brand
    // colour to suit a fixed ink. The app now labels solid fills with
    // `text-text-inverse`, itself var-driven, so the readable choice is a
    // property of the colour: dark ink on a light accent, white on a dark one.
    // This is why the previous luminance *clamp* is gone — it silently altered
    // a customer's brand colour (a pale mint arrived visibly darker) to protect
    // an assumption that no longer holds.
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const isLight = brightness > 150;
    const ink = isLight ? "18 33 44" : "255 255 255";

    // Distinct hover shade — without this the accent-hover token collapses to
    // the base colour and branded buttons lose their hover feedback. Move AWAY
    // from the ink: a light accent brightens, a dark one darkens, so the chosen
    // ink stays legible through the hover state too.
    const hov = (c: number) =>
      isLight ? Math.round(c + (255 - c) * 0.22) : Math.round(c * 0.85);

    const channels = `${r} ${g} ${b}`;
    const hoverChannels = `${hov(r)} ${hov(g)} ${hov(b)}`;
    const css = `:root{--brand-primary-rgb:${channels};--brand-primary-hover-rgb:${hoverChannels};--brand-ink-rgb:${ink};}`;
    return <style dangerouslySetInnerHTML={{ __html: css }} />;
  } catch {
    return null;
  }
}
