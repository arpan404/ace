import type { FakeSpadeApi } from "@ace/fake-daemon";

const hexHash = (seed: string) => seed.repeat(64).slice(0, 64);

const ROUTE_MAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" width="640" height="400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#191b22"/>
      <stop offset="100%" stop-color="#12141a"/>
    </linearGradient>
    <linearGradient id="river" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1d2d3e" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="#162230" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="route" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#e07a5f"/>
      <stop offset="55%" stop-color="#f2a65a"/>
      <stop offset="100%" stop-color="#81b29a"/>
    </linearGradient>
  </defs>
  <rect width="640" height="400" fill="url(#bg)"/>
  <g stroke="#ffffff" stroke-opacity="0.05" stroke-width="1">
    <path d="M0 80 H640 M0 160 H640 M0 240 H640 M0 320 H640"/>
    <path d="M128 0 V400 M256 0 V400 M384 0 V400 M512 0 V400"/>
  </g>
  <path d="M0 328 C140 310, 260 352, 420 330 C520 318, 580 302, 640 296 L640 400 L0 400 Z" fill="url(#river)"/>
  <path d="M96 292 C164 256, 224 236, 286 206 C356 172, 424 148, 528 96" fill="none" stroke="url(#route)" stroke-width="5" stroke-linecap="round"/>
  <path d="M96 292 C142 276, 178 266, 214 242" fill="none" stroke="#e07a5f" stroke-width="2.5" stroke-dasharray="5 5" opacity="0.8"/>
  <g font-family="ui-sans-serif, system-ui, -apple-system, sans-serif">
    <circle cx="96" cy="292" r="8" fill="#191b22" stroke="#e07a5f" stroke-width="3.5"/>
    <text x="114" y="297" fill="#f4f4f6" font-size="14" font-weight="600">Chiado · Casa do Largo</text>
    <text x="114" y="314" fill="#9ca3af" font-size="11">5 min walk to Rossio</text>
    <circle cx="286" cy="206" r="8" fill="#191b22" stroke="#f2a65a" stroke-width="3.5"/>
    <text x="304" y="203" fill="#f4f4f6" font-size="14" font-weight="600">Rossio Station</text>
    <text x="304" y="220" fill="#9ca3af" font-size="11">09:11 · 09:31 direct rail</text>
    <circle cx="528" cy="96" r="9" fill="#81b29a"/>
    <circle cx="528" cy="96" r="15" fill="none" stroke="#81b29a" stroke-opacity="0.35" stroke-width="2"/>
    <text x="412" y="76" fill="#f4f4f6" font-size="14" font-weight="600">Sintra · Pena</text>
    <text x="412" y="93" fill="#9ca3af" font-size="11">40 min · arr 09:51</text>
    <rect x="24" y="24" width="212" height="54" rx="10" fill="#0d0f14" fill-opacity="0.72" stroke="#ffffff" stroke-opacity="0.08"/>
    <text x="40" y="47" fill="#f4f4f6" font-size="13" font-weight="600">Lisbon Day 2 Route</text>
    <text x="40" y="65" fill="#9ca3af" font-size="11">Chiado → Rossio → Sintra · 28 km</text>
    <text x="530" y="376" fill="#6b8399" font-size="11" letter-spacing="1.4">RIO TEJO</text>
  </g>
</svg>`;

const METRO_MAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320" width="480" height="320">
  <rect width="480" height="320" fill="#161820"/>
  <path d="M56 260 L180 180 L310 180 L424 88" fill="none" stroke="#4ea8de" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M90 64 L180 180 L236 264" fill="none" stroke="#52b788" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M120 264 L310 180 L416 228" fill="none" stroke="#e9c46a" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="#161820" stroke="#f8fafc" stroke-width="3">
    <circle cx="180" cy="180" r="7"/>
    <circle cx="310" cy="180" r="7"/>
    <circle cx="424" cy="88" r="6"/>
    <circle cx="90" cy="64" r="6"/>
  </g>
  <g font-family="ui-sans-serif, system-ui, sans-serif" fill="#e5e7eb" font-size="13" font-weight="600">
    <text x="24" y="34">Lisbon Metro · Baixa-Chiado</text>
    <text x="150" y="164" font-size="11" fill="#cbd5e1">Baixa-Chiado</text>
    <text x="290" y="164" font-size="11" fill="#cbd5e1">Alameda</text>
    <text x="364" y="76" font-size="11" fill="#cbd5e1">Aeroporto</text>
  </g>
</svg>`;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Minimal valid single-page PDF with readable text lines so browsers preview it cleanly. */
function makeFakePdf(title: string, lines: readonly string[]): string {
  const streamLines = [
    "BT",
    "/F1 18 Tf",
    "54 740 Td",
    `(${esc(title)}) Tj`,
    "/F1 11 Tf",
    "0 -28 Td",
    ...lines.flatMap((line) => [`(${esc(line)}) Tj`, "0 -18 Td"]),
    "ET",
  ].join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${streamLines.length} >>\nstream\n${streamLines}\nendstream\nendobj\n`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(out.length);
    out += obj;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const HASHES = {
  routeMap: hexHash("a1"),
  shortlistPdf: hexHash("b2"),
  boardingPdf: hexHash("c3"),
  itineraryMd: hexHash("d4"),
  hotelsCsv: hexHash("e5"),
  sintraPdf: hexHash("f6"),
  offlineZip: hexHash("17"),
} as const;

/**
 * Seeds chat attachments in Spade's conversation: one inline image, one PDF, a person message
 * with a PDF attachment, and a small group of 4 files.
 */
export function seedFakeSpadeChatMedia(
  here: FakeSpadeApi,
  spade: { id: string; conversation: string },
) {
  here.images.set(HASHES.routeMap, "image/svg+xml");
  here.media.imageBodies.set(HASHES.routeMap, { body: ROUTE_MAP_SVG });

  const shortlistText = [
    "Lisbon Hotel Shortlist — 14–18 Nov 2026",
    "",
    "1. Casa do Largo (Chiado) — EUR 178/night, 9.1 rating, free cancellation until 12 Nov",
    "2. Hotel Lusa (Baixa) — EUR 164/night, 8.7 rating, non-refundable",
    "3. Brasileira Suites (Chiado) — EUR 171/night, 8.9 rating, free cancellation until 10 Nov",
    "",
    "Recommendation: Casa do Largo — 5 minutes on foot to Rossio Station for Sintra trains.",
  ].join("\n");
  here.media.documentBodies.set(HASHES.shortlistPdf, {
    body: makeFakePdf("Lisbon Hotel Shortlist (14-18 Nov 2026)", shortlistText.split("\n")),
    contentType: "application/pdf",
    text: shortlistText,
  });

  const boardingText = [
    "TAP Air Portugal — Booking Confirmation QX7K2P",
    "Flight TP1351 · 14 Nov · 07:40 OPO -> 08:40 LIS · Seat 14C (Aisle)",
    "Fare: Classic — 1 carry-on (10 kg) + 1 checked bag (23 kg) included.",
  ].join("\n");
  here.media.documentBodies.set(HASHES.boardingPdf, {
    body: makeFakePdf("TAP Confirmation QX7K2P", boardingText.split("\n")),
    contentType: "application/pdf",
    text: boardingText,
  });

  const itineraryText =
    "# Lisbon Itinerary (14–18 Nov)\n\n- **Day 1**: Arrive 08:40, drop bags at Casa do Largo, walk Chiado & Carmo.\n- **Day 2**: 09:11 Rossio → Sintra, Pena Palace & Quinta da Regaleira.\n- **Day 3**: Belém tram, MAAT, sunset at Miradouro da Senhora do Monte.\n- **Day 4**: LX Factory & return flight.\n";
  here.media.documentBodies.set(HASHES.itineraryMd, {
    body: itineraryText,
    contentType: "text/markdown",
    text: itineraryText,
  });

  const hotelsCsv =
    "hotel,area,eur_night,rating,cancellation\nCasa do Largo,Chiado,178,9.1,Free until 12 Nov\nHotel Lusa,Baixa,164,8.7,Non-refundable\nBrasileira Suites,Chiado,171,8.9,Free until 10 Nov\n";
  here.media.documentBodies.set(HASHES.hotelsCsv, {
    body: hotelsCsv,
    contentType: "text/csv",
    text: hotelsCsv,
  });

  const sintraText =
    "CP Urbanos — Rossio to Sintra Timetable\n08:51 -> 09:31\n09:11 -> 09:51\n09:31 -> 10:11\nTrains run every 20 minutes.";
  here.media.documentBodies.set(HASHES.sintraPdf, {
    body: makeFakePdf("Rossio -> Sintra Rail Timetable", sintraText.split("\n")),
    contentType: "application/pdf",
    text: sintraText,
  });

  here.media.documentBodies.set(HASHES.offlineZip, {
    body: "PK\x03\x04fake-archive-lisbon-maps",
    contentType: "application/zip",
    text: "Archive containing offline Chiado and Sintra vector tiles (3 files).",
  });

  // 1. Bot shares an inline image with a caption.
  const imgCaption = "Mapped out the walk from Chiado to Rossio and the Sintra rail line.";
  here.store(spade.conversation, { type: "reply_started", reply: "r-media-img" });
  here.store(spade.conversation, {
    type: "step_finished",
    reply: "r-media-img",
    text: imgCaption,
  });
  here.store(spade.conversation, {
    type: "shared",
    reply: "r-media-img",
    call_id: "c-media-img",
    images: [{ sha256: HASHES.routeMap, media_type: "image/svg+xml", bytes: 42_810 }],
  });
  here.store(spade.conversation, {
    type: "reply_finished",
    reply: "r-media-img",
    text: imgCaption,
  });

  // 2. Bot shares a single PDF document with a caption.
  const pdfCaption = "Here's the side-by-side shortlist with cancellation terms.";
  here.store(spade.conversation, { type: "reply_started", reply: "r-media-pdf" });
  here.store(spade.conversation, {
    type: "step_finished",
    reply: "r-media-pdf",
    text: pdfCaption,
  });
  here.store(spade.conversation, {
    type: "shared",
    reply: "r-media-pdf",
    call_id: "c-media-pdf",
    documents: [
      {
        sha256: HASHES.shortlistPdf,
        name: "lisbon-hotel-shortlist-2026.pdf",
        media_type: "application/pdf",
        bytes: 2_516_582,
        pages: 6,
        chars: shortlistText.length,
        cut: false,
      },
    ],
  });
  here.store(spade.conversation, {
    type: "reply_finished",
    reply: "r-media-pdf",
    text: pdfCaption,
  });

  // 3. Person sends a message with an attached PDF and a caption.
  here.store(spade.conversation, {
    type: "user_message",
    text: "Here's my TAP confirmation — does it include a checked bag?",
    documents: [
      {
        sha256: HASHES.boardingPdf,
        name: "tap-confirmation-qx7k2p.pdf",
        media_type: "application/pdf",
        bytes: 348_160,
        pages: 2,
        chars: boardingText.length,
        cut: false,
      },
    ],
  });

  // 4. Bot shares a small group of 4 files with a caption.
  const groupCaption =
    "Yes — Classic fare includes 10 kg carry-on plus a 23 kg checked bag. I bundled the rest of the trip pack below.";
  here.store(spade.conversation, { type: "reply_started", reply: "r-media-group" });
  here.store(spade.conversation, {
    type: "step_finished",
    reply: "r-media-group",
    text: groupCaption,
  });
  here.store(spade.conversation, {
    type: "shared",
    reply: "r-media-group",
    call_id: "c-media-group",
    documents: [
      {
        sha256: HASHES.itineraryMd,
        name: "lisbon-itinerary-november.md",
        media_type: "text/markdown",
        bytes: 4_820,
        chars: itineraryText.length,
        cut: false,
      },
      {
        sha256: HASHES.hotelsCsv,
        name: "hotels-price-comparison.csv",
        media_type: "text/csv",
        bytes: 18_432,
        sheets: 2,
        chars: hotelsCsv.length,
        cut: false,
      },
      {
        sha256: HASHES.sintraPdf,
        name: "sintra-trains-timetable.pdf",
        media_type: "application/pdf",
        bytes: 614_400,
        pages: 4,
        chars: sintraText.length,
        cut: false,
      },
      {
        sha256: HASHES.offlineZip,
        name: "lisbon-offline-maps-bundle.zip",
        media_type: "application/zip",
        bytes: 8_912_896,
        chars: 0,
        cut: false,
      },
    ],
  });
  here.store(spade.conversation, {
    type: "reply_finished",
    reply: "r-media-group",
    text: groupCaption,
  });
}

/** Adds image files, downloads, person attachments, and modified timestamps to Spade's workspace. */
export function seedFakeSpadeWorkspaceMedia(here: FakeSpadeApi, now: number) {
  const existing = here.files.get("spade") ?? {};
  here.files.set("spade", {
    ...existing,
    "lisbon-route-map.svg": ROUTE_MAP_SVG,
    "downloads/sintra-palace-tickets.pdf": makeFakePdf("Pena Palace Timed Entry", [
      "15 Nov 2026 · 10:00 Entry · 2 Adults",
      "Order #PT-88412",
    ]),
    "downloads/lisbon-metro-map.svg": METRO_MAP_SVG,
    "attachments/tap-confirmation-qx7k2p.pdf": makeFakePdf("TAP Confirmation QX7K2P", [
      "Flight TP1351 · 14 Nov · 07:40 OPO -> 08:40 LIS",
      "Classic fare · 23 kg checked bag included",
    ]),
    "attachments/chiado-wishlist.md":
      "# Places to try near Chiado\n\n- A Brasileira for morning bica\n- Taberna da Rua das Flores\n- Livraria Bertrand\n",
  });
  const m = (mins: number) => now - mins * 60_000;
  here.media.fileTimes.set("spade", {
    "lisbon-trip.md": m(3),
    "lisbon-route-map.svg": m(8),
    "hotels.csv": m(14),
    "fares-checked.md": m(1),
    "research/hotel-shortlist.md": m(38),
    "receipts/tap-qx7k2p.txt": m(95),
    "downloads/sintra-palace-tickets.pdf": m(22),
    "downloads/lisbon-metro-map.svg": m(140),
    "attachments/tap-confirmation-qx7k2p.pdf": m(11),
    "attachments/chiado-wishlist.md": m(60 * 19),
  });
}
