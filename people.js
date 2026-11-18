// People the maker knows by name.
//
// The model only understands descriptions, not names or photos. So when a prompt mentions one of
// these names, the name is swapped for the description before the model sees it:
//   "Haim running"  ->  "a bearded man with short dark hair and a gray scarf running"
//
// Keep each description short (about ten words). The model reads only the first 22 words or so
// of a prompt, and at 16 x 16 pixels only hair, beard, glasses and clothing colour can show.
// This file is public, like the rest of the site: only add people who are fine with that.

export const PEOPLE = [{ name: "Haim", looks: "a bearded man with short dark hair and a gray scarf" }];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Swap every known name in `prompt` for that person's description.
 * Names match as whole words, in any letter case. Returns the text for the model and who was found.
 */
export function expandPeople(prompt, people = PEOPLE) {
  const used = [];
  let text = prompt;
  for (const person of people) {
    const name = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(person.name)}(?![\\p{L}\\p{N}])`, "giu");
    if (!name.test(text)) continue;
    text = text.replace(name, person.looks);
    used.push(person);
  }
  return { text, used };
}
