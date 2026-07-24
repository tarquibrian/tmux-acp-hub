// ACP Hub's visual theme contract. Structural accents may follow the Vanzi
// family or the active ACP provider, while semantic colours (permission,
// error, success) remain the responsibility of their rendering surface.

const THEME_VARIANTS = Object.freeze(["vanzi", "agent"]);
const VANZI_ACCENT_FOREGROUND = "\x1b[38;5;168m";
const PROVIDER_ACCENT_CODES = Object.freeze({ claude: 173, codex: 39 });

const NEUTRAL = Object.freeze({
  surfaceBackground: "\x1b[48;2;14;14;14m",
  surfaceHoverBackground: "\x1b[48;2;42;42;42m",
  surfaceSelectedBackground: "\x1b[48;2;57;57;57m",
  text: "\x1b[38;2;185;185;185m",
  textStrong: "\x1b[38;2;247;247;247m",
  textDisabled: "\x1b[38;2;121;115;115m",
});

function normalizeHubTheme(value, fallback = "vanzi") {
  const normalized = String(value || "").trim().toLowerCase();
  return THEME_VARIANTS.includes(normalized) ? normalized : fallback;
}

function foregroundSgrAsBackground(sequence) {
  return String(sequence || "").replace("[38;", "[48;");
}

function knownProviderAccentSeq(provider, tty = process.stdout.isTTY) {
  if (!tty) return "";
  const id = String(provider || "").trim().toLowerCase();
  const code = PROVIDER_ACCENT_CODES[id];
  return code ? `\x1b[38;5;${code}m` : "";
}

function resolveHubThemePalette({
  variant = "vanzi",
  provider = "",
  vanziAccentSeq = "",
  tty = process.stdout.isTTY,
} = {}) {
  const normalizedVariant = normalizeHubTheme(variant);
  const vanzi = tty ? vanziAccentSeq || VANZI_ACCENT_FOREGROUND : "";
  const providerAccent = knownProviderAccentSeq(provider, tty);
  const accentForeground = normalizedVariant === "agent"
    ? providerAccent || vanzi
    : vanzi;

  return Object.freeze({
    variant: normalizedVariant,
    accentForeground,
    accentBackground: foregroundSgrAsBackground(accentForeground),
    ...NEUTRAL,
  });
}

export {
  THEME_VARIANTS,
  VANZI_ACCENT_FOREGROUND,
  PROVIDER_ACCENT_CODES,
  NEUTRAL,
  normalizeHubTheme,
  foregroundSgrAsBackground,
  knownProviderAccentSeq,
  resolveHubThemePalette,
};
