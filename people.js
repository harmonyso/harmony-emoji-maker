// People the maker knows by name.
//
// The model only understands descriptions, not names or photos. So when a prompt mentions one of
// these names, the prompt is rewritten before the model sees it:
//
//   "Tal waving"      ->  "a man waving, ginger hair, ginger beard, purple t-shirt"
//   "Dudu with hair"  ->  "a man with hair, glasses, short beard, purple t-shirt"
//
// Two things here were learned by trying wordings on the real model (see sheet.html):
//
// 1. What the person is doing has to come first. With the description first and the action last
//    ("a man with ginger hair and a ginger beard in a purple t-shirt waving") the model often
//    ignores the action. So the name becomes just "a man" or "a woman", the rest of the prompt
//    stays next to it, and the person's features are listed at the end.
// 2. This small model mixes colours up easily: "a dark beard and white t-shirt" came out as a
//    white beard. One colour word per feature, and short features, work best.
//
// Each feature has a kind. If the prompt itself talks about that kind of thing ("with hair",
// "in a red suit", "with sunglasses"), the person's own feature of that kind is left out, so
// the prompt wins instead of contradicting it.
//
// Everyone wears a purple t-shirt, the Harmony colour; a logo cannot fit on a shirt six pixels
// wide. Keep features short: the model reads only the first 22 or so words of a prompt.
// This file is public, like the rest of the site: only add people who are fine with that.
//
// "Or" and "Ran" are also everyday English words ("a cat or a dog", "a dog that ran"), so those
// two have capital: true and only count as names when written with a capital letter.

const SHIRT = { kind: "clothes", text: "purple t-shirt" };

export const PEOPLE = [
  { name: "Haim", noun: "man", features: [{ kind: "hair", text: "curly dark hair" }, { kind: "beard", text: "beard" }, SHIRT] },
  { name: "Nir", noun: "man", features: [{ kind: "hair", text: "brown hair" }, { kind: "glasses", text: "glasses" }, SHIRT] },
  { name: "Tal", noun: "man", features: [{ kind: "hair", text: "ginger hair" }, { kind: "beard", text: "ginger beard" }, SHIRT] },
  { name: "Alon", noun: "man", features: [{ kind: "hair", text: "dark quiff" }, { kind: "beard", text: "stubble" }, SHIRT] },
  {
    name: "Ran",
    noun: "man",
    capital: true,
    features: [{ kind: "hair", text: "short dark hair" }, { kind: "beard", text: "beard" }, { kind: "clothes", text: "purple shirt and tie" }],
  },
  {
    name: "Or",
    noun: "woman",
    capital: true,
    features: [{ kind: "hair", text: "dark hair tied back" }, { kind: "jewelry", text: "earrings" }, SHIRT],
  },
  {
    name: "Dudu",
    noun: "man",
    features: [{ kind: "hair", text: "bald" }, { kind: "glasses", text: "glasses" }, { kind: "beard", text: "short beard" }, SHIRT],
  },
];

/** Words in a prompt that mean "I am deciding this myself", by kind of feature. */
const OVERRIDES = {
  hair: /\b(hair|haired|bald|ponytail|mohawk|afro|wig|curls|braids?|dreadlocks)\b/i,
  beard: /\b(beard|bearded|shaved|shaven|mustache|moustache|stubble|goatee)\b/i,
  glasses: /\b(glasses|sunglasses|shades|goggles)\b/i,
  clothes: /\b(shirt|t-shirt|tshirt|suit|tuxedo|jacket|hoodie|dress|coat|sweater|uniform|costume|armor|armour|robe|jersey)\b/i,
  jewelry: /\b(earrings?|necklace|jewelry|jewellery)\b/i,
};

/** Words after which "a man" reads better than a bare "man": "with a man", "and a man". */
const WANTS_ARTICLE = /(^|[,;:]|\b(and|with|of|to|by|for|like|or|vs|at|on|near|beside|hugging|meets?|from))$/i;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nameFinder = (person) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(person.name)}(?![\\p{L}\\p{N}])`, person.capital ? "gu" : "giu");

/** One line for the page: who it knows, and which names need their capital letter. */
export function describePeople(people = PEOPLE) {
  if (!people.length) return "";
  const strict = people.filter((p) => p.capital).map((p) => p.name);
  const list = new Intl.ListFormat("en", { type: "conjunction" });
  return (
    `It knows these people by name: ${people.map((p) => p.name).join(", ")}.` +
    (strict.length ? ` Write ${list.format(strict)} with a capital letter.` : "")
  );
}

/**
 * Rewrite a prompt that mentions known people. Names match as whole words.
 * Returns the text for the model, and for each person found: their name, the features that were
 * used, and the kinds of feature the prompt decided for itself.
 */
export function expandPeople(prompt, people = PEOPLE) {
  const found = people.filter((p) => nameFinder(p).test(prompt));
  if (!found.length) return { text: prompt, used: [] };

  // What the person typed apart from the names decides which features they are overriding.
  let rest = prompt;
  for (const p of found) rest = rest.replace(nameFinder(p), " ");
  const overridden = Object.keys(OVERRIDES).filter((kind) => OVERRIDES[kind].test(rest));

  let text = prompt;
  const tail = [];
  const used = [];
  for (const p of found) {
    text = text.replace(nameFinder(p), (_match, offset, whole) => {
      const before = whole.slice(0, offset).trimEnd();
      return WANTS_ARTICLE.test(before) ? `a ${p.noun}` : p.noun;
    });
    const kept = p.features.filter((f) => !overridden.includes(f.kind));
    for (const f of kept) if (!tail.includes(f.text)) tail.push(f.text);
    used.push({
      name: p.name,
      noun: p.noun,
      features: kept.map((f) => f.text),
      overridden: p.features.filter((f) => overridden.includes(f.kind)).map((f) => f.kind),
    });
  }
  text = [text.replace(/\s+/g, " ").trim(), ...tail].join(", ");
  return { text, used };
}

/** A sentence for the page saying how a named person will be painted. */
export function explain(person) {
  const base = `${person.name} is painted as a ${person.noun}`;
  const feats = person.features.length ? ` with ${person.features.join(", ")}` : "";
  const yours = person.overridden.length ? ` Your prompt decides the ${person.overridden.join(" and ")}.` : "";
  return `${base}${feats}.${yours}`;
}
