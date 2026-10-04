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
  // The intro wraps like the page would in a narrow viewport.
  const intro =
    width - x - 24 >= 330
      ? ["Phones paired with this Mac can approve, answer", "and watch threads from anywhere."]
      : ["Phones paired with this Mac can", "approve, answer and watch threads", "from anywhere."];
  const shift = (intro.length - 2) * 20;
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
${intro.map((line, index) => `<text x="${x}" y="${92 + index * 20}" fill="#55555E">${line}</text>`).join("")}
<g transform="translate(0 ${shift})">
<text x="${x}" y="158" font-weight="500" fill="#1C1C22">Device name</text>
<rect x="${x}" y="170" width="${field}" height="38" rx="8" fill="#FFFFFF" stroke="#3B74E0" stroke-width="2"/>
<text x="${x + 12}" y="194" fill="#1C1C22">${escape(typed)}</text>
<text x="${x}" y="244" font-weight="500" fill="#1C1C22">Pairing code</text>
<rect x="${x}" y="256" width="${field}" height="38" rx="8" fill="#FFFFFF" stroke="#D6D6DA"/>
<text x="${x + 12}" y="280" font-family="ui-monospace, monospace" letter-spacing="4" fill="#1C1C22">7KQ2-M9XA</text>
<rect x="${x}" y="320" width="112" height="38" rx="8" fill="#1C1C22"/>
<text x="${x + 19}" y="344" font-weight="500" fill="#FFFFFF">Pair device</text>
</g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Any other page the fake browser shows: the address's host as the page heading over a few
 * content blocks, so navigating visibly changes the screencast without fetching anything.
 */
export function sitePage(url: string, width = 760, height = 900): string {
  if (url === "about:blank")
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/></svg>`,
    )}`;
  let host = url;
  let path = "/";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    // Keep the address as given.
  }
  const column = Math.min(640, width - 64);
  const x = Math.max(32, Math.round((width - column) / 2));
  const lines = [0.92, 0.84, 0.88, 0.6]
    .map(
      (fraction, index) =>
        `<rect x="${x}" y="${196 + index * 26}" width="${Math.round(column * fraction)}" height="10" rx="5" fill="#E4E4E9"/>`,
    )
    .join("");
  const cards = [0, 1]
    .map((index) => {
      const cardWidth = Math.round((column - 16) / 2);
      return `<rect x="${x + index * (cardWidth + 16)}" y="330" width="${cardWidth}" height="140" rx="12" fill="#F4F4F7"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, system-ui, sans-serif" font-size="14">
<rect width="${width}" height="${height}" fill="#FFFFFF"/>
<rect width="${width}" height="56" fill="#FAFAFB"/><rect y="56" width="${width}" height="1" fill="#EBEBEF"/>
<text x="${x}" y="34" font-weight="600" fill="#1C1C22">${escape(host)}</text>
<text x="${x}" y="128" font-size="26" font-weight="600" fill="#1C1C22">${escape(path === "/" ? host : path)}</text>
<text x="${x}" y="160" fill="#6B6B75">${escape(url)}</text>
${lines}${cards}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
