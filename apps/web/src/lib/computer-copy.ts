/** Desktop/web wording for shared descriptions that still use the internal machine term. */
export function computerCopy(text: string): string {
  return text.replace(/\b(machine|machines|Machine|Machines)\b/g, (word) => {
    switch (word) {
      case "machine":
        return "computer";
      case "machines":
        return "computers";
      case "Machine":
        return "Computer";
      default:
        return "Computers";
    }
  });
}
