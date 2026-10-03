/**
 * A screencast frame of the page an agent is driving: ace's own "Pair a phone" settings
 * page, drawn as SVG so the fake browser needs no image assets. `typed` is the device name
 * as typed so far, which lets a scenario animate the agent filling in the form.
 */
const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

export function pairPhoneFrame(typed: string, width = 760, height = 900): string {
  const nav = 170;
  const x = nav + 32;
  const field = Math.min(440, width - x - 32);
  const items = ["General", "Accounts", "Devices", "Notifications", "Shortcuts"]
    .map((label, index) => {
      const y = 104 + index * 36;
      const on = label === "Devices";
      return `${on ? `<rect x="12" y="${y - 21}" width="${nav - 24}" height="30" rx="7" fill="#E9E9EE"/>` : ""}<text x="24" y="${y}" fill="${on ? "#1C1C22" : "#55555E"}">${label}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, system-ui, sans-serif" font-size="14">
<rect width="${width}" height="${height}" fill="#FFFFFF"/>
<rect width="${nav}" height="${height}" fill="#F7F7F9"/><rect x="${nav}" width="1" height="${height}" fill="#E6E6EA"/>
<text x="24" y="48" font-weight="600" fill="#1C1C22">ace</text>${items}
<text x="${x}" y="64" font-size="21" font-weight="500" fill="#1C1C22">Pair a phone</text>
<text x="${x}" y="92" fill="#55555E">Phones paired with this Mac can approve, answer</text>
<text x="${x}" y="112" fill="#55555E">and watch threads from anywhere.</text>
<text x="${x}" y="158" font-weight="500" fill="#1C1C22">Device name</text>
<rect x="${x}" y="170" width="${field}" height="38" rx="8" fill="#FFFFFF" stroke="#3B74E0" stroke-width="2"/>
<text x="${x + 12}" y="194" fill="#1C1C22">${escape(typed)}</text>
<text x="${x}" y="244" font-weight="500" fill="#1C1C22">Pairing code</text>
<rect x="${x}" y="256" width="${field}" height="38" rx="8" fill="#FFFFFF" stroke="#D6D6DA"/>
<text x="${x + 12}" y="280" font-family="ui-monospace, monospace" letter-spacing="4" fill="#1C1C22">7KQ2-M9XA</text>
<rect x="${x}" y="320" width="112" height="38" rx="8" fill="#1C1C22"/>
<text x="${x + 19}" y="344" font-weight="500" fill="#FFFFFF">Pair device</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
