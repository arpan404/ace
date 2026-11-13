/*
 * `?fakeWorld=spade`: pictures of the bots' browsers and screens, drawn here as SVG, so the
 * computer's tile and expanded view show something real-looking without a daemon. The shape is
 * the Spade slice's `BotStreams`; input is taken and dropped. Fixtures, never the person's screen.
 */

interface Key {
  machine: string;
  bot: string;
  surface: "browser" | "screen";
}

const hotels = [
  {
    name: "Casa do Largo",
    where: "Chiado · 0.3 km from Baixa-Chiado",
    price: 178,
    score: "9.1",
    hue: ["#d9a679", "#a8714a"],
  },
  {
    name: "Hotel Lusa",
    where: "Chiado · 0.5 km from Baixa-Chiado",
    price: 164,
    score: "8.7",
    hue: ["#9fb6cf", "#5d7d9e"],
    picked: true,
  },
  {
    name: "Brasileira Suites",
    where: "Chiado · 0.2 km from Baixa-Chiado",
    price: 171,
    score: "8.9",
    hue: ["#c9c08a", "#8a8146"],
  },
  {
    name: "Rio Tejo Rooms",
    where: "Cais do Sodré · 0.9 km",
    price: 149,
    score: "8.2",
    hue: ["#b9a0cf", "#7a5e96"],
  },
];

const font = "font-family='-apple-system, Helvetica, Arial, sans-serif'";

function staybook(): string {
  const cards = hotels
    .map((hotel, index) => {
      const y = 92 + index * 150;
      return `
      <defs><linearGradient id="g${index}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hotel.hue[0]}"/><stop offset="1" stop-color="${hotel.hue[1]}"/></linearGradient></defs>
      <rect x="24" y="${y}" width="912" height="134" rx="10" fill="#fff" stroke="${hotel.picked ? "#1f4fd1" : "#e6e8ee"}" stroke-width="${hotel.picked ? 2.5 : 1}"/>
      <rect x="38" y="${y + 14}" width="150" height="106" rx="6" fill="url(#g${index})"/>
      <text x="206" y="${y + 36}" font-size="19" font-weight="600" fill="#15171c" ${font}>${hotel.name}</text>
      <text x="206" y="${y + 60}" font-size="15" fill="#5b6070" ${font}>${hotel.where}</text>
      <rect x="206" y="${y + 74}" width="34" height="22" rx="4" fill="#1f4fd1"/>
      <text x="223" y="${y + 90}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle" ${font}>${hotel.score}</text>
      <text x="250" y="${y + 90}" font-size="15" fill="#3b3f4a" ${font}>Excellent</text>
      <text x="916" y="${y + 34}" font-size="15" fill="#5b6070" text-anchor="end" ${font}>4 nights</text>
      <text x="916" y="${y + 66}" font-size="22" font-weight="700" fill="#15171c" text-anchor="end" ${font}>€${hotel.price}</text>
      <rect x="816" y="${y + 84}" width="100" height="36" rx="6" fill="#1f4fd1"/>
      <text x="866" y="${y + 108}" font-size="15" font-weight="600" fill="#fff" text-anchor="middle" ${font}>Reserve</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">
    <rect width="960" height="720" fill="#f4f5f8"/>
    <rect width="960" height="68" fill="#fff"/>
    <line x1="0" y1="68" x2="960" y2="68" stroke="#e6e8ee"/>
    <text x="24" y="43" font-size="24" font-weight="700" fill="#1f4fd1" ${font}>staybook</text>
    <rect x="150" y="14" width="786" height="40" rx="20" fill="#eef0f4"/>
    <text x="170" y="40" font-size="15" fill="#5b6070" ${font}>Lisbon · 14–18 Nov · 2 guests · under €180</text>
    ${cards}
  </svg>`;
}

function textEdit(): string {
  const lines = [
    { y: 168, w: 420, c: "#d4d7de" },
    { y: 192, w: 520, c: "#d4d7de" },
    { y: 216, w: 360, c: "#d4d7de" },
    { y: 288, w: 480, c: "#d4d7de" },
    { y: 312, w: 300, c: "#7fa2e8" },
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
    <defs><linearGradient id="desk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2b44"/><stop offset="1" stop-color="#0f1626"/></linearGradient></defs>
    <rect width="960" height="600" fill="url(#desk)"/>
    <rect width="960" height="24" fill="#0b0f18" opacity="0.8"/>
    <text x="40" y="17" font-size="13" font-weight="600" fill="#e8eaf0" ${font}>TextEdit</text>
    <text x="110" y="17" font-size="13" fill="#c9ccd6" ${font}>File   Edit   Format   View   Window</text>
    <rect x="120" y="60" width="720" height="480" rx="10" fill="#fdfdfd"/>
    <rect x="120" y="60" width="720" height="34" rx="10" fill="#ececef"/>
    <circle cx="142" cy="77" r="6" fill="#ff5f57"/><circle cx="162" cy="77" r="6" fill="#febc2e"/><circle cx="182" cy="77" r="6" fill="#28c840"/>
    <text x="480" y="82" font-size="13" fill="#555" text-anchor="middle" ${font}>Release notes 0.0.22 — Edited</text>
    <text x="160" y="140" font-size="22" font-weight="700" fill="#15171c" ${font}>ace 0.0.22</text>
    ${lines.map((line) => `<rect x="160" y="${line.y}" width="${line.w}" height="10" rx="5" fill="${line.c}"/>`).join("")}
    <text x="160" y="268" font-size="17" font-weight="700" fill="#15171c" ${font}>Fixes</text>
    <rect x="462" y="304" width="2" height="18" fill="#1f4fd1"/>
  </svg>`;
}

const pictures = {
  browser: { svg: staybook(), width: 960, height: 720 },
  screen: { svg: textEdit(), width: 960, height: 600 },
};

const dataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function fakeBotStreams() {
  return {
    watch(key: Key, show: (picture: { src: string; width: number; height: number }) => void) {
      // Only the bots the fake world shows at work have a picture.
      const shown =
        (key.bot === "spade" && key.surface === "browser") ||
        (key.bot === "notes" && key.surface === "screen");
      if (!shown) return () => {};
      const picture = pictures[key.surface];
      const timer = setTimeout(
        () => show({ src: dataUrl(picture.svg), width: picture.width, height: picture.height }),
        0,
      );
      return () => clearTimeout(timer);
    },
    input: async () => {},
  };
}
