/**
 * A screencast frame of the page an agent is driving: ace's own "Pair a phone" settings
 * page, drawn as SVG so the fake browser needs no image assets. `typed` is the device name
 * as typed so far, which lets a scenario animate the agent filling in the form.
 */
const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

export function pairPhoneFrame(typed: string, width = 1280, height = 800): string {
  const nav = ["General", "Accounts", "Devices", "Notifications", "Shortcuts"]
    .map((label, index) => {
      const y = 120 + index * 40;
      const on = label === "Devices";
      return `${on ? `<rect x="16" y="${y - 22}" width="208" height="34" rx="8" fill="#E9E9EE"/>` : ""}<text x="32" y="${y}" fill="${on ? "#1C1C22" : "#55555E"}">${label}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, system-ui, sans-serif" font-size="15">
<rect width="${width}" height="${height}" fill="#FFFFFF"/>
<rect width="240" height="${height}" fill="#F7F7F9"/><rect x="240" width="1" height="${height}" fill="#E6E6EA"/>
<text x="32" y="56" font-weight="600" fill="#1C1C22">ace</text>${nav}
<text x="300" y="86" font-size="24" font-weight="500" fill="#1C1C22">Pair a phone</text>
<text x="300" y="116" fill="#55555E">Phones paired with this Mac can approve, answer and watch threads from anywhere.</text>
<text x="300" y="172" font-weight="500" fill="#1C1C22">Device name</text>
<rect x="300" y="186" width="520" height="40" rx="8" fill="#FFFFFF" stroke="#3B74E0" stroke-width="2"/>
<text x="314" y="212" fill="#1C1C22">${escape(typed)}</text>
<text x="300" y="262" font-weight="500" fill="#1C1C22">Pairing code</text>
<rect x="300" y="276" width="520" height="40" rx="8" fill="#FFFFFF" stroke="#D6D6DA"/>
<text x="314" y="302" font-family="ui-monospace, monospace" letter-spacing="4" fill="#1C1C22">7KQ2-M9XA</text>
<rect x="300" y="344" width="120" height="40" rx="8" fill="#1C1C22"/>
<text x="321" y="369" font-weight="500" fill="#FFFFFF">Pair device</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
