// The text with its first character in capitals, such as a clause that starts a
// sentence.
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
