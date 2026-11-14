// Ordered masking rules. Every pattern is linear: left boundaries so a match
// start is tried once per token run, no unbounded lookahead per start position.
// Order: anthropic before openai (so sk-ant- is labelled anthropic); headers and
// password-kv last. A value never swallows an existing "[masked:...]" label, so
// the function is idempotent.
//
// Known trade-off: bare "key: value" forms under 6 characters (password=abc)
// are not masked, to keep prose like "token: ok" readable. Quoted values and
// conn-string / header / URL forms are masked at any length. conn-string only
// matches a Password=/Pwd= that follows a ";" (a Password= first in the string
// takes the password-kv path), so plain "password=..." keeps its own label.

const NM = String.raw`(?!\[masked:)`;

type Rule = { re: RegExp; to: string };

function rx(source: string, flags: string): RegExp {
  return new RegExp(source, flags);
}

const RULES: Rule[] = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[^-]|-(?!----))*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g,
    to: "[masked:private-key]",
  },
  {
    re: rx(
      String.raw`(?<=;[ \t]*)((?:Password|Pwd)[ \t]*=[ \t]*)${NM}[^;\s](?:${NM}[^;\n])*`,
      "gim",
    ),
    to: "$1[masked:conn-string]",
  },
  {
    re: rx(String.raw`(AccountKey=|SharedAccessKey=|SharedAccessSignature=)${NM}[^;\s]+`, "g"),
    to: "$1[masked:azure-conn]",
  },
  { re: rx(String.raw`([?&]sig=)${NM}[^&\s"']+`, "g"), to: "$1[masked:sas-sig]" },
  {
    re: rx(String.raw`((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*://[^:/\s@]*:)${NM}[^@\s/]+(?=@)`, "gi"),
    to: "$1[masked:url-cred]",
  },
  { re: /(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+/g, to: "[masked:jwt]" },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}/g, to: "[masked:github]" },
  { re: /sk-ant-[\w-]{20,}/g, to: "[masked:anthropic]" },
  { re: /sk-(?:proj|svcacct|admin)-[\w-]{20,}|sk-[A-Za-z0-9]{32,}/g, to: "[masked:openai]" },
  { re: /xox[abprs]-[\w-]{10,}/g, to: "[masked:slack]" },
  { re: /AKIA[0-9A-Z]{16}(?![0-9A-Z])/g, to: "[masked:aws]" },
  { re: /(?<![\w:])\d{8,10}:[\w-]{35}(?![\w-])/g, to: "[masked:telegram]" },
  { re: /(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, to: "[masked:stripe]" },
  { re: /(?<![\w-])AIza[\w-]{35}(?![\w-])/g, to: "[masked:google]" },
  { re: /(?<![\w.-])SG\.[\w-]{22}\.[\w-]{43}(?![\w-])/g, to: "[masked:sendgrid]" },
  { re: /(?<!\w)npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, to: "[masked:npm]" },
  { re: /(?<![\w-])glpat-[\w-]{20,}/g, to: "[masked:gitlab]" },
  { re: /(?<![\w-])hf_[A-Za-z0-9]{30,}/g, to: "[masked:huggingface]" },
  { re: /(?<![\w.-])hv[sbr]\.[\w-]{24,}/g, to: "[masked:vault]" },
  {
    re: /https:\/\/(?:hooks\.slack\.com\/services\/[A-Za-z0-9/]+|(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+)/g,
    to: "[masked:webhook]",
  },
  {
    re: rx(
      String.raw`(?<![\w-])(Authorization["']?[ \t]*:[ \t]*["']?(?:Bearer|Basic|token)[ \t]+)${NM}[^\s"']+`,
      "gi",
    ),
    to: "$1[masked:auth-header]",
  },
  {
    re: rx(
      String.raw`(?<![\w-])((?:x-api-key|api-key|ocp-apim-subscription-key)["']?[ \t]*:[ \t]*["']?)${NM}[^\s"']+`,
      "gi",
    ),
    to: "$1[masked:api-key-header]",
  },
  // A bearer token outside an Authorization header (curl -H, logs): 20+ token characters.
  {
    re: rx(String.raw`(?<![\w-])(Bearer[ \t]+)${NM}[A-Za-z0-9._~+/-]{20,}=*`, "g"),
    to: "$1[masked:bearer]",
  },
];

const SEP = String.raw`(["']?[ \t]*[=:][ \t]*)`;
// The identifier must END with the keyword (client_secret, db.password,
// AWS_SECRET_ACCESS_KEY match; max_tokens, secretary do not). Left boundary
// means one start per identifier run; backtracking inside a run is O(run).
const PASSWORD_KEY = rx(
  String.raw`(?<![\w.-])((?:[\w.-]*[_.-])?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|(?:secret|signing|hmac|private|encryption|master)[_-]?key))${SEP}`,
  "gi",
);
// camelCase keys (accessToken, clientSecret, dbPassword): the keyword starts with an upper-case
// letter right after a lower-case letter or digit. Case-sensitive, so maxTokens, inputTokens and
// secretary still fail at the separator. Same left boundary and cost as PASSWORD_KEY.
const CAMEL_KEY = rx(
  String.raw`(?<![\w.-])([\w.-]*[a-z0-9](?:Password|Passwd|Pwd|Secret|Token|ApiKey|AccessKey|SecretKey|SigningKey|HmacKey|PrivateKey|EncryptionKey|MasterKey))${SEP}`,
  "g",
);

// Personal data (PII-02). A candidate is masked only when its check digits are valid, so ids,
// timestamps and other digit runs stay readable. Both patterns are bounded: one start per run.
// Known gap: a card whose run with the groups next to it passes 19 digits ("1234 4111 1111 1111 1111")
// is not one match and stays visible. A longer bound would cut runs of several cards at arbitrary
// places and make masking depend on where a match starts.
const CARD = /(?<![\w.-])(?:\d[ -]?){12,18}\d(?![\w-])/g;
const IBAN =
  /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;

/**
 * Card-network prefixes with the lengths each issues (Visa, Mastercard incl. 2-series, Amex,
 * Discover, UnionPay, JCB). Amounts and ids of other shapes stay visible even when Luhn passes.
 */
const CARD_SHAPES: readonly { prefix: RegExp; lengths: readonly number[] }[] = [
  { prefix: /^4/, lengths: [16, 19] },
  { prefix: /^5[1-5]/, lengths: [16] },
  { prefix: /^2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)/, lengths: [16] },
  { prefix: /^3[47]/, lengths: [15] },
  { prefix: /^(?:6011|65|64[4-9])/, lengths: [16, 17, 18, 19] },
  { prefix: /^62/, lengths: [16, 17, 18, 19] },
  { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
];

/** A card-network prefix and length, and a valid Luhn check. */
function isCard(candidate: string): boolean {
  const d = candidate.replace(/[ -]/g, "");
  if (!CARD_SHAPES.some((c) => c.prefix.test(d) && c.lengths.includes(d.length))) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * How a card is written inside a longer digit run: one unbroken group, groups of four (16 digits,
 * or 19 with a last group of 1 to 3), or Amex 4-6-5. Lists of short numbers never match, so a
 * window search over them adds no false positives.
 */
const CARD_WINDOW = /^(?:\d+|\d{4}(?:[ -]\d{4}){3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5})$/;

/**
 * Masks a CARD match. The match can also hold digit groups before or after the card (a CVV or an
 * expiry next to it), so when the whole run is not a card, try every card-shaped window of 15 to 19
 * digits that starts at the beginning or after a separator and ends at the end or before one,
 * longest first, and keep the text around it. Two cards cannot share one match (at most 19 digits).
 * A match is at most 37 characters, so this stays cheap.
 */
function maskCard(m: string): string {
  if (isCard(m)) return "[masked:card]";
  // Group boundaries: group g spans m.slice(starts[g], ends[g]); digitsBefore[g] counts the digits
  // in groups 0..g-1.
  const starts = [0];
  const ends: number[] = [];
  for (let k = 1; k < m.length; k++) {
    if (m[k] === " " || m[k] === "-") {
      ends.push(k);
      starts.push(k + 1);
    }
  }
  ends.push(m.length);
  if (starts.length === 1) return m;
  const digitsBefore = [0];
  for (let g = 0; g < starts.length; g++) {
    digitsBefore.push((digitsBefore[g] ?? 0) + ((ends[g] ?? 0) - (starts[g] ?? 0)));
  }
  let best: [number, number] | null = null;
  for (let a = 0; a < starts.length; a++) {
    for (let b = a; b < ends.length; b++) {
      const digits = (digitsBefore[b + 1] ?? 0) - (digitsBefore[a] ?? 0);
      if (digits < 15 || digits > 19) continue;
      const i = starts[a] ?? 0;
      const k = ends[b] ?? 0;
      if (best !== null && k - i <= best[1] - best[0]) continue;
      const w = m.slice(i, k);
      if (CARD_WINDOW.test(w) && isCard(w)) best = [i, k];
    }
  }
  return best === null ? m : `${m.slice(0, best[0])}[masked:card]${m.slice(best[1])}`;
}

/** ISO 13616 mod-97 check. */
function isIban(candidate: string): boolean {
  const s = candidate.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const v = code >= 65 ? String(code - 55) : ch;
    for (const digit of v) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}
const LABEL = "[masked:";
const PLAIN_RUN = /[^\s[]*/y;
const IN_DOUBLE = /[^"\n]*/y;
const IN_SINGLE = /[^'\n]*/y;
const PATHLIKE = /^["']?(?:[/\\]|[A-Za-z]:\\)/;

/**
 * End of the value that starts at `i`, or -1 when there is none. The value is a quoted string
 * ("..." or '...' on one line, not starting with a label) or else the run of non-space characters
 * up to the first label, at least 6 long. Scanned by hand: the same pattern as a regex group costs
 * about 150 ns per character in JavaScriptCore, too slow for a 1 MB value.
 */
function valueEnd(s: string, i: number): number {
  const q = s[i];
  if ((q === '"' || q === "'") && !s.startsWith(LABEL, i + 1)) {
    const inner = q === '"' ? IN_DOUBLE : IN_SINGLE;
    inner.lastIndex = i + 1;
    inner.exec(s);
    const j = inner.lastIndex;
    if (s[j] === q && j > i + 1) return j + 1;
  }
  // Each step stops at whitespace, the end, or a "["; only a "[" that starts a label ends the value.
  let j = i;
  for (;;) {
    PLAIN_RUN.lastIndex = j;
    PLAIN_RUN.exec(s);
    j = PLAIN_RUN.lastIndex;
    if (s[j] !== "[" || s.startsWith(LABEL, j)) break;
    j += 1;
  }
  return j - i >= 6 ? j : -1;
}

/** `pwd: /some/path` is a working directory, not a password. */
function isPwdPath(key: string, value: string): boolean {
  const pwdKey = /(?:^|[_.-])(?:pwd|passwd)$/i.test(key) || /[a-z0-9](?:Pwd|Passwd)$/.test(key);
  return pwdKey && PATHLIKE.test(value);
}

/** Masks the value after every key that `keyRe` finds; keeps the key and separator. Linear. */
function maskKv(text: string, keyRe: RegExp): string {
  let out = "";
  let last = 0;
  keyRe.lastIndex = 0;
  for (let m = keyRe.exec(text); m !== null; m = keyRe.exec(text)) {
    const key = m[1] ?? "";
    const sep = m[2] ?? "";
    const start = m.index + m[0].length;
    const end = valueEnd(text, start);
    if (end < 0) {
      keyRe.lastIndex = m.index + 1;
      continue;
    }
    const kept = isPwdPath(key, text.slice(start, end));
    out += `${text.slice(last, m.index)}${kept ? text.slice(m.index, end) : `${key}${sep}[masked:password-kv]`}`;
    last = end;
    keyRe.lastIndex = end;
  }
  return out + text.slice(last);
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const { re, to } of RULES) out = out.replace(re, to);
  out = out.replace(CARD, maskCard);
  out = out.replace(IBAN, (m) => (isIban(m) ? "[masked:iban]" : m));
  return maskKv(maskKv(out, PASSWORD_KEY), CAMEL_KEY);
}
