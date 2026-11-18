// People the maker knows by name.
//
// The model only understands descriptions, not names or photos. So when a prompt mentions one of
// these names, the name is swapped for the description before the model sees it:
//   "Haim running"  ->  "a bearded man with curly dark hair in a purple t-shirt running"
//
// Every description here was tried on the real model first (see sheet.html), because this small
// model mixes colours up easily: "a dark beard and white t-shirt" came out as a white beard.
// What works: one colour word per thing, hair and beard first, clothing last. Everyone wears a
// purple t-shirt, the Harmony colour; a logo cannot fit on a shirt six pixels wide.
// Keep descriptions to about a dozen words: the model reads only the first 22 or so words of a
// prompt, and whatever the person is doing comes after the description.
// This file is public, like the rest of the site: only add people who are fine with that.
//
// "Or" and "Ran" are also everyday English words ("a cat or a dog", "a dog that ran"), so those
// two have capital: true and only count as names when written with a capital letter.

export const PEOPLE = [
  { name: "Haim", looks: "a bearded man with curly dark hair in a purple t-shirt" },
  { name: "Nir", looks: "a man with brown hair and glasses in a purple t-shirt" },
  { name: "Tal", looks: "a man with ginger hair and a ginger beard in a purple t-shirt" },
  { name: "Alon", looks: "a man with a dark quiff and stubble in a purple t-shirt" },
  { name: "Ran", looks: "a bearded man with short dark hair in a purple shirt and tie", capital: true },
  { name: "Or", looks: "a woman with dark hair tied back and earrings in a purple t-shirt", capital: true },
  { name: "Dudu", looks: "a bald man with glasses and a short beard in a purple t-shirt" },
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
