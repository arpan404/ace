import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, a bot's panels (ADR 0200 §5.2): Fare watch's package ships "Watched trips",
 * a page that lists what it watches with a Stop for each; pressing one tells the bot, which says
 * so and sets the panel again. Price check's page throws on its own, so it stops. For checking
 * panels by eye in both schemes, in the real sandboxed frame.
 */

const watchedPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Watched trips</title>
<style>
  body { margin: 0; padding: 4px 16px 16px; font: 14px/1.45 var(--font-sans, system-ui); color: var(--foreground); }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .route { font-weight: 500; }
  .when { color: var(--muted-foreground); font-size: 13px; }
  .fare { font-variant-numeric: tabular-nums; text-align: right; }
  .change { display: block; color: var(--muted-foreground); font-size: 12px; }
  button { font: inherit; font-size: 13px; color: var(--foreground); background: transparent; border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px; cursor: pointer; }
  button:hover { background: var(--hover); }
  .empty { color: var(--muted-foreground); }
</style>
</head>
<body>
<ul id="trips"></ul>
<p class="empty" id="empty" hidden>Nothing watched. Tell Fare watch a route.</p>
<script>
  const list = document.getElementById("trips");
  const empty = document.getElementById("empty");
  function text(tag, className, words) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = words;
    return node;
  }
  function row(trip) {
    const item = document.createElement("li");
    const what = document.createElement("div");
    what.append(text("div", "route", trip.route), text("div", "when", trip.when));
    const fare = text("div", "fare", "€" + trip.fare);
    fare.append(text("span", "change", trip.change));
    const stop = text("button", "", "Stop");
    stop.addEventListener("click", () => acePanel.act("stop_watching", trip.route));
    item.append(what, fare, stop);
    return item;
  }
  function show(state) {
    const trips = (state && state.trips) || [];
    list.replaceChildren(...trips.map(row));
    empty.hidden = trips.length > 0;
  }
  addEventListener("ace:state", (event) => show(event.detail));
  show(acePanel.state);
</script>
</body>
</html>`;

/** A page with a bug: it throws three times, and ace stops it. */
const brokenPage = `<!doctype html><html><head><title>Prices</title></head><body>
<p>Loading prices…</p>
<script>for (let i = 1; i <= 3; i++) setTimeout(() => { throw new Error("prices is undefined"); }, 300 * i);</script>
</body></html>`;

const trips = [
  { route: "Porto to Lisbon", when: "14 May, 07:40", fare: "78", change: "−12 today" },
  { route: "Porto to Madrid", when: "2 Jun, 09:15", fare: "112", change: "no change" },
  { route: "Lisbon to Paris", when: "20 Jun, 18:05", fare: "96", change: "+4 today" },
];

export function seedFakeAgentPanels(here: FakeSpadeApi) {
  const fares = here.agents.find((agent) => agent.id === "fares");
  if (fares) {
    let watched = trips;
    here.panels.set(
      fares,
      [
        {
          id: "watched",
          title: "Watched trips",
          html: watchedPage,
          actions: [{ name: "stop_watching", label: "Stop watching" }],
        },
      ],
      (action) => {
        const route = typeof action.value === "string" ? action.value : "";
        watched = watched.filter((trip) => trip.route !== route);
        const words = `Stopped watching ${route}. Still watching ${watched.length} trips.`;
        here.store(fares.conversation, { type: "reply_started", reply: `r-stop-${route}` });
        here.store(fares.conversation, {
          type: "step_finished",
          reply: `r-stop-${route}`,
          text: words,
          calls: [],
        });
        here.store(fares.conversation, {
          type: "reply_finished",
          reply: `r-stop-${route}`,
          text: words,
        });
        here.panels.update(fares, "watched", { trips: watched });
      },
    );
    here.panels.update(fares, "watched", { trips: watched });
  }
  const prices = here.addAgent({
    id: "prices",
    name: "Price check",
    task: "Check the prices of what I name each morning.",
  });
  here.panels.set(prices, [{ id: "prices", title: "Prices", html: brokenPage, actions: [] }]);
  here.store(prices.conversation, { type: "user_message", text: "Show me today's prices." });
}
