// People the maker knows by name.
//
// The model only understands descriptions, not names or photos. So when a prompt mentions one of
// these names, the name is swapped for the description before the model sees it:
//   "Haim running"  ->  "a bearded man with short dark hair and a gray scarf running"
//
// Keep each description short (about ten words). The model reads only the first 22 words or so
// of a prompt, and at 16 x 16 pixels only hair, beard, glasses and clothing colour can show.
// This file is public, like the rest of the site: only add people who are fine with that.
//
// "Or" and "Ran" are also everyday English words ("a cat or a dog", "a dog that ran"), so those
// two have capital: true and only count as names when written with a capital letter.

export const PEOPLE = [
  { name: "Haim", looks: "a bearded man with short dark hair and a gray scarf" },
  { name: "Nir", looks: "a smiling man with brown hair, glasses and a blue shirt" },
  { name: "Tal", looks: "a man with ginger hair, a ginger beard and a dark jacket" },
  { name: "Alon", looks: "a man with a dark quiff, short beard and black suit" },
  { name: "Ran", looks: "a man with short dark hair, a dark beard and white t-shirt", capital: true },
  { name: "Or", looks: "a woman with dark hair tied back, earrings and a white t-shirt", capital: true },
  { name: "Dudu", looks: "a bald man with glasses, a short beard and a gray coat" },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
 * Swap every known name in `prompt` for that person's description.
 * Names match as whole words, in any letter case. Returns the text for the model and who was found.
 */
export function expandPeople(prompt, people = PEOPLE) {
  const used = [];
  let text = prompt;
  for (const person of people) {
    const flags = person.capital ? "gu" : "giu";
    const name = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(person.name)}(?![\\p{L}\\p{N}])`, flags);
    if (!name.test(text)) continue;
    text = text.replace(name, person.looks);
    used.push(person);
  }
  return { text, used };
}
